// 아이콘 생성용 1회성 스크립트 — `npx electron build/gen-icon.js`로 실행
// SVG를 오프스크린 렌더링해서 여러 크기의 PNG를 뽑고, 그걸 직접 ICO 컨테이너로 묶음
// (별도 이미지 변환 도구/패키지 없이 Electron 자체 렌더러+nativeImage만 사용)
const { app, BrowserWindow, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256, height: 256, show: false,
    frame: false, useContentSize: true, // 타이틀바/테두리 때문에 캡처가 정사각형이 아니게 잘렸었음
    webPreferences: { offscreen: false }
  })
  const svgPath = path.join(__dirname, 'icon-src.svg')
  const html = `<!DOCTYPE html><html><head><style>
    html,body{margin:0;padding:0;width:256px;height:256px;background:transparent;}
    img{width:256px;height:256px;display:block;}
  </style></head><body><img src="file:///${svgPath.replace(/\\/g,'/')}"></body></html>`
  const htmlPath = path.join(__dirname, '_icon-render.html')
  fs.writeFileSync(htmlPath, html, 'utf-8')
  await win.loadFile(htmlPath)
  await new Promise(r => setTimeout(r, 200)) // 이미지 디코딩 여유

  const base = await win.webContents.capturePage() // 256x256 NativeImage (실제 표시 배율 그대로)
  const basePng = base.toPNG()
  fs.writeFileSync(path.join(__dirname, 'icon.png'), basePng)

  const pngBuffers = SIZES.map(size => {
    const resized = base.resize({ width: size, height: size, quality: 'best' })
    return { size, buf: resized.toPNG() }
  })

  // ── ICO 컨테이너 직접 조립 (PNG를 그대로 담는 최신 포맷 — Windows Vista+ 지원) ──
  const count = pngBuffers.length
  const headerSize = 6 + count * 16
  let offset = headerSize
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)      // reserved
  header.writeUInt16LE(1, 2)      // type: 1 = icon
  header.writeUInt16LE(count, 4)  // image count

  const dirEntries = []
  const imageDatas = []
  for (const { size, buf } of pngBuffers) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)  // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)  // height (0 = 256)
    entry.writeUInt8(0, 2)   // color palette
    entry.writeUInt8(0, 3)   // reserved
    entry.writeUInt16LE(1, 4)  // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(buf.length, 8)  // size of image data
    entry.writeUInt32LE(offset, 12)     // offset of image data
    offset += buf.length
    dirEntries.push(entry)
    imageDatas.push(buf)
  }

  const ico = Buffer.concat([header, ...dirEntries, ...imageDatas])
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico)

  fs.unlinkSync(htmlPath)
  console.log('생성 완료: build/icon.ico, build/icon.png')
  app.quit()
})
