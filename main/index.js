const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')

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
    width: W,
    height: H_INITIAL,
    x: prefs.pos?.x,
    y: prefs.pos?.y,
    frame: false,
    alwaysOnTop: pinned,
    resizable: false, // 사용자가 직접 드래그로 리사이즈 못 함 — 내용 크기에 맞춰 자동으로만 조절됨
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (pinned) win.setAlwaysOnTop(true, 'floating')

  win.once('ready-to-show', () => win.show())

  win.on('close', () => {
    const b = win.getBounds()
    const p = loadPrefs()
    savePrefs({ ...p, pos: { x: b.x, y: b.y } })
  })

  // 타이틀바(app-region: drag)를 더블클릭하면 Windows가 자동으로 전체화면 처리해버림 —
  // 위젯이라 원하는 동작이 아니라서, 최대화되면 즉시 되돌림
  win.on('maximize', () => win.unmaximize())

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

app.whenReady().then(() => {
  createWindow()

  // 자동 업데이트 — GitHub Releases 확인 후 있으면 조용히 받아서 다음 실행 때 적용
  autoUpdater.checkForUpdatesAndNotify()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
