const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')

// 이 위젯은 텍스트/CSS 위주라 GPU 가속이 딱히 필요 없음 — 켜져있으면 특히 그래픽카드가
// 약하거나 가상화된 환경(회사 노트북, 원격 데스크톱 등)에서 GPU 프로세스 초기화 때문에
// 창이 뜨는 데 시간이 걸릴 수 있어서, app.whenReady() 전에 꺼서 그 과정 자체를 건너뜀
app.disableHardwareAcceleration()

app.setPath('userData', path.join(app.getPath('appData'), 'TKM Calendar'))

const W = 243        // 기존 304의 80% — 렌더러의 CSS zoom:0.8과 짝을 맞춤(app.js의 WIDGET_W와 일치해야 함)
const H_INITIAL = 340 // 초기값일 뿐, 로드 직후 렌더러가 실제 콘텐츠 크기로 다시 맞춤

function prefsPath() { return path.join(app.getPath('userData'), 'prefs.json') }
function localDataPath() { return path.join(app.getPath('userData'), 'local-data.json') }

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsPath(), 'utf-8').replace(/^﻿/, ''))
  } catch {
    return { pos: null, pinned: true }
  }
}
function savePrefs(prefs) {
  const p = prefsPath()
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(prefs), 'utf-8')
  fs.renameSync(tmp, p)
}

// 로컬 전용 데이터(최근 업무, 개인 할일) — 구글 캘린더로 절대 안 올라감, 이 컴퓨터에만 저장.
// Tack에서 겪었던 데이터 유실 사고 이후 확립된 패턴 그대로: 원자적 쓰기(tmp+rename) +
// 파싱 실패 시 손상 파일을 별도 백업해두고 빈 기본값으로 복구(있던 파일을 덮어써서 완전히
// 날리지 않음).
function loadLocalData() {
  const p = localDataPath()
  try {
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^﻿/, ''))
      d.recentTasks ??= []
      d.personalTodos ??= []
      d.personalEvents ??= []
      return d
    }
  } catch (err) {
    console.error('[local-data] load error:', err)
    try { fs.copyFileSync(p, p + '.corrupt.' + Date.now()) } catch {}
  }
  return { recentTasks: [], personalTodos: [], personalEvents: [] }
}
function saveLocalData(data) {
  const p = localDataPath()
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8')
  fs.renameSync(tmp, p)
}

let win = null

function createWindow() {
  const prefs = loadPrefs()
  const pinned = prefs.pinned !== false // 기본값 true

  win = new BrowserWindow({
    width: prefs.width || W,
    height: H_INITIAL,
    minWidth: 200,
    minHeight: 100,
    x: prefs.pos?.x,
    y: prefs.pos?.y,
    frame: false,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'), // 기본 Electron 아이콘 대신 TKM 아이콘 — 개발모드 실행 시에도 적용됨
    alwaysOnTop: pinned,
    // 우하단 핸들로 폭을 늘려서 긴 글자(일정 제목 등)가 안 잘리게 볼 수 있게 함 —
    // 높이는 여전히 내용에 맞춰 자동 조절(resizeToContent가 매번 다시 맞춤), 폭만 사용자가
    // 바꾼 값을 기억해서 유지함(main/index.js의 close 핸들러 + app.js의 window.innerWidth 사용 참고)
    resizable: true,
    // 타이틀바(드래그 영역)를 더블클릭하면 Windows가 최대화/폭 늘리기를 시도하는데,
    // maximizable:false로 아예 그 제스처 자체를 못 하게 막음 — resizable은 그대로라 우하단
    // 핸들로 수동 리사이즈하는 건 영향 없음
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // 포커스 없을 때도(위젯 특성상 항상 그럴 수 있음) 정상적으로 계속 그려지게 함
    }
  })

  if (pinned) win.setAlwaysOnTop(true, 'floating')

  // alwaysOnTop + frameless 창은 처음 뜰 때 Windows가 포커스를 안 줘서 입력창에 바로
  // 글자가 안 써지는 경우가 있다고 함 — show() 뒤에 명시적으로 focus()까지 호출해서 방지
  win.once('ready-to-show', () => { win.show(); win.focus() })

  // 렌더러 console.log를 이 터미널로도 그대로 보이게 함 — 여백 버그 진단용 로그를
  // 개발자도구 안 열고 바로 여기서 확인하려고(문제 재현되면 [resize] 로그부터 확인)
  win.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('[resize]')) console.log(message)
  })

  win.on('close', () => {
    const b = win.getBounds()
    const p = loadPrefs()
    savePrefs({ ...p, pos: { x: b.x, y: b.y }, width: b.width })
  })

  // Tack처럼 창이 포커스를 잃으면(다른 데 클릭) 열려있던 모달/팝업을 닫음
  win.on('blur', () => win.webContents.send('win-blur'))
  // 다시 포커스를 얻으면(클릭해서 돌아옴) 접어뒀던 화면을 원래대로 복원
  win.on('focus', () => win.webContents.send('win-focus'))

  win.loadFile(path.join(__dirname, '..', 'frontend', 'index.html'))
}

// ── 창 컨트롤 IPC (frontend/app.js가 이미 호출하는 이름들과 일치) ──
ipcMain.handle('win-minimize', () => { win?.minimize() })
ipcMain.handle('win-close', () => { win?.close() })

ipcMain.handle('get-pin', () => {
  const p = loadPrefs()
  return p.pinned !== false
})
ipcMain.handle('toggle-pin', () => {
  if (!win) return true
  const p = loadPrefs()
  const next = p.pinned === false // false→true, true→false
  win.setAlwaysOnTop(next, 'floating')
  if (next) win.moveTop()
  savePrefs({ ...p, pinned: next })
  return next
})

ipcMain.handle('get-local-data', () => loadLocalData())
ipcMain.handle('save-local-data', (_, data) => { saveLocalData(data); return true })

// 윈도우 시작 시 자동 실행 — 개발 모드(npx electron .)에서는 electron.exe 자체를 등록해버려서
// 의미가 없고, 실제 설치된 앱(패키징된 실행 파일)에서만 제대로 동작함
ipcMain.handle('get-auto-launch', () => app.getLoginItemSettings().openAtLogin)
ipcMain.handle('toggle-auto-launch', () => {
  const next = !app.getLoginItemSettings().openAtLogin
  app.setLoginItemSettings({ openAtLogin: next })
  return next
})

// 개인 ICS 캘린더 구독 — 렌더러(브라우저 환경)에서 직접 fetch하면 CORS로 막히는 외부 주소가
// 많아서, CORS 제약이 없는 main 프로세스(Node)에서 대신 받아다 줌. 사용자별로 각자 다른 주소를
// 넣을 수 있고, 이 컴퓨터 안에서만 쓰임(팀 캘린더/백엔드와는 무관)
ipcMain.handle('fetch-ics', async (_e, url) => {
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('http(s) 주소만 지원함')
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const text = await res.text()
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
})

// 렌더러가 실제 콘텐츠 높이를 재서 요청하는 리사이즈 — 화면 밖으로 안 나가게 클램프
ipcMain.on('win-resize', (e, w, h) => {
  try {
    if (win) {
      const [x, y] = win.getPosition()
      const rw = Math.round(w), rh = Math.round(h)
      const { workArea } = screen.getDisplayNearestPoint({ x, y })
      const clampedX = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - rw))
      const clampedY = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - rh))
      win.setBounds({ x: clampedX, y: clampedY, width: rw, height: rh }, false)
    }
  } catch (err) { console.error('[win-resize]', err) }
  e.returnValue = null
})

// -webkit-app-region:drag 대신 쓰는 커스텀 드래그 이동 — 렌더러가 mousemove 델타를 보내주면
// 그만큼 창 위치를 옮김(OS 드래그 영역으로 지정하면 dblclick이 아예 안 뜨는 문제가 있어서 이렇게 함)
ipcMain.on('win-move-by', (e, dx, dy) => {
  if (!win) return
  const [x, y] = win.getPosition()
  win.setPosition(Math.round(x + dx), Math.round(y + dy))
})

// 자동 업데이트 — 평범한 앱처럼: 실행할 때 한 번만 조회 -> 있으면 "업데이트 하시겠습니까?" 확인창 ->
// Yes 누르면 그때 다운로드 -> 다 받으면 조용히 설치하고 자동으로 새 버전으로 재시작.
// 주기적(6시간) 백그라운드 체크와 수동 확인 버튼은 "언제 됐는지 모르게 조용히 진행"돼서
// 오히려 헷갈린다는 피드백으로 제거함 — 조회는 실행 시점 1회뿐, 못 찾거나 실패해도 조용히 넘어감
function sendUpdateStatus(status, extra) {
  win?.webContents.send('update-status', { status, extra })
}
autoUpdater.on('update-available', (info) => {
  sendUpdateStatus('available', info.version) // 여기서 다운로드 시작 안 함 — 렌더러가 Yes/No 확인창 띄우고, Yes일 때만 downloadUpdate() 요청
})
autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', Math.round(p.percent)))
autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus('downloaded', info.version)
  // 렌더러가 "설치 중..." 문구를 잠깐 보여줄 시간을 준 뒤 조용히 설치 + 자동 재시작
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 800)
})

ipcMain.handle('get-app-version', () => app.getVersion())
ipcMain.handle('confirm-update', () => {
  autoUpdater.downloadUpdate() // "업데이트 하시겠습니까?" 확인창에서 Yes 눌렀을 때만 호출됨
  return true
})

app.whenReady().then(() => {
  createWindow()

  // 실행 시점에 딱 한 번만 조회. 업데이트가 있으면 렌더러가 확인창을 띄움(위 update-available)
  if (app.isPackaged) autoUpdater.checkForUpdates()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
