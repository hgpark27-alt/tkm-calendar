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

// 자동 업데이트 상태를 렌더러(톱니 메뉴)에도 보여주기 위해 이벤트를 그대로 전달
function sendUpdateStatus(status, extra) {
  win?.webContents.send('update-status', { status, extra })
}
autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
autoUpdater.on('update-available', (info) => {
  // 있는지 없는지부터 먼저 화면에 보여주고, 그 다음 단계로 다운로드 시작 —
  // checkForUpdatesAndNotify()는 이 둘을 구분 없이 한번에 처리해서 반응이 뭉뚱그려 보였음
  sendUpdateStatus('available', info.version)
  autoUpdater.downloadUpdate()
})
autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', Math.round(p.percent)))
autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'))
autoUpdater.on('error', (err) => sendUpdateStatus('error', err?.message))
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', info.version))

ipcMain.handle('check-for-updates', () => {
  // 패키징 안 된 개발 모드(npx electron .)에서는 electron-updater가 조용히 아무것도 안 함 —
  // 그러면 버튼이 그냥 안 되는 것처럼 보이니 이 경우만 바로 안내 메시지를 보내줌
  if (!app.isPackaged) {
    sendUpdateStatus('error', '개발 모드에서는 업데이트 확인이 안 됨(설치된 앱에서만 동작)')
    return true
  }
  autoUpdater.checkForUpdates()
  return true
})

app.whenReady().then(() => {
  createWindow()

  // 자동 업데이트 — 실행 시점(지금)과, 이후 6시간마다 GitHub Releases 확인 후 있으면
  // 조용히 받아서 다음 실행 때 적용. 톱니 메뉴의 "Check for Updates"로 수동으로도 가능(위 핸들러)
  autoUpdater.checkForUpdatesAndNotify()
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 6 * 60 * 60 * 1000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
