const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')

// 이 위젯은 텍스트/CSS 위주라 GPU 가속이 딱히 필요 없음 — 켜져있으면 특히 그래픽카드가
// 약하거나 가상화된 환경(회사 노트북, 원격 데스크톱 등)에서 GPU 프로세스 초기화 때문에
// 창이 뜨는 데 시간이 걸릴 수 있어서, app.whenReady() 전에 꺼서 그 과정 자체를 건너뜀
app.disableHardwareAcceleration()

app.setPath('userData', path.join(app.getPath('appData'), 'TKM Calendar'))

// 창을 여러 개(자동실행 중복 등록, 실수로 두 번 실행 등) 띄우면 업데이트 설치 시 같은 실행파일을
// 서로 물고 있어서 "Failed to uninstall old app files" 에러가 나는 원인이 됨 — 앱은 항상 하나만
// 떠 있게 강제하고, 이미 떠 있는데 또 실행되면 새로 띄우는 대신 기존 창을 앞으로 가져옴
if (!app.requestSingleInstanceLock()) {
  app.quit()
  return
}
app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

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
    // 200이면 타이틀바 아이콘이 7개(새로고침/다이어리/설정/알림/고정/최소화/닫기)라 폭이 모자라서
    // 닫기(×) 버튼 오른쪽이 잘렸음(실측으로 확인) — 다 들어가는 최소값으로 올림
    minWidth: 220,
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

// 윈도우 시작 시 자동 실행 — 예전엔 app.setLoginItemSettings()(레지스트리 Run 키)를 썼는데,
// 개발 모드(npx electron .)에서 이 토글을 한 번이라도 켜면 그때 실행 중이던 electron.exe 자체가
// (개발 모드 앱 이름은 "Electron"이라 실제 설치본과 이름이 달라서) 별개 항목으로 레지스트리에
// 남아버려서, 부팅할 때마다 인자 없는 electron.exe가 실행되며 Electron 기본 데모 화면이 떴었음
// (실측으로 확인) — 반드시 패키징된 앱에서만 등록/해제되게 막아야 함.
//
// 처음엔 작업 스케줄러(schtasks, 로그온 시 트리거는 레지스트리 Run 키의 지연 실행 정책을 안 타서
// 더 빠르게 뜸)로 바꿨는데, 실제로 써보니 "ERROR: Access is denied"로 실패함 — 회사 정책이
// 일반 계정의 작업 스케줄러 등록 자체를 막아놓은 상태였음(schtasks /Create를 터미널에서 직접
// 실행해서 확인). 그래서 시작프로그램 폴더에 바로가기(.lnk)를 만드는 방식으로 다시 바꿈 — 이건
// 그냥 내 계정 폴더에 파일 하나 쓰는 거라 그 정책 제한을 안 받음(실측으로 쓰기 가능 확인).
// 다만 로그인 직후 지연 실행 정책은 이 방식도 어느 정도 적용될 수 있어서, 빠른 실행이 100%
// 보장되진 않음 — 이 회사 정책 안에서는 그 이상 손쓸 방법이 마땅치 않음.
function startupShortcutPath() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'TKM Calendar.lnk')
}
ipcMain.handle('get-auto-launch', () => {
  if (!app.isPackaged) return Promise.resolve(false) // 개발 모드에서는 항상 꺼짐으로 표시 — 등록 자체를 안 함
  return Promise.resolve(fs.existsSync(startupShortcutPath()))
})
ipcMain.handle('toggle-auto-launch', () => {
  if (!app.isPackaged) return Promise.resolve(false) // 개발 모드에서는 토글 무시 — 예전 버그 재발 방지
  const linkPath = startupShortcutPath()
  return new Promise((resolve) => {
    if (fs.existsSync(linkPath)) {
      try { fs.unlinkSync(linkPath) } catch (err) { console.error('[auto-launch] delete failed', err) }
      resolve(fs.existsSync(linkPath)) // 삭제 실패 시(드묾) 상태를 있는 그대로 알려줌
      return
    }
    const exe = process.execPath
    const psCmd = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${linkPath}'); $s.TargetPath='${exe}'; $s.Save()`
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], (err) => {
      if (err) console.error('[auto-launch] create failed', err)
      resolve(fs.existsSync(linkPath))
    })
  })
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

// 다이어리 모드는 내용을 화면 크기에 맞춰 늘리고 줄이는 방식이라(그리드가 flex/grid로 남는 공간을
// 다 채움), 너무 작게 줄이면 칸이 못 알아볼 정도로 찌그러짐 — 그래서 다이어리 모드에 들어갈 때만
// 최소 크기를 더 크게 잡고, 나갈 때 원래 최소 크기(200x100)로 되돌림
ipcMain.on('win-set-min-size', (e, w, h) => {
  if (win) win.setMinimumSize(Math.round(w), Math.round(h))
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
//
// electron-updater는 기본값(autoDownload:true)이 켜져 있으면 checkForUpdates()가 업데이트를
// 찾자마자 그 자리에서 바로 다운로드까지 자동으로 진행해버림 — "확인창에서 Yes 눌러야 다운로드
// 시작"이라고 아래 주석에 적어놓고 실제로는 이 기본값을 꺼둔 적이 없어서, 확인창은 그냥 보여주기용
// 이었고 실제로는 사용자 응답과 무관하게 항상 자동으로 받아서 설치까지 진행되고 있었음(사용자가
// "Yes 안 눌렀는데 지 혼자 꺼진다"고 겪은 문제의 원인). 반드시 꺼서 downloadUpdate()가 오직
// confirm-update IPC(Yes 클릭)로만 시작되게 함.
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
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

  // 예전 방식(레지스트리 Run 키)으로 켜져 있던 사용자가 있으면 한 번만 정리 —
  // 꺼주고, 켜져 있었다면 새 방식(시작프로그램 폴더 바로가기)으로 그대로 이어서 켜줌
  if (app.isPackaged) {
    try {
      if (app.getLoginItemSettings().openAtLogin) {
        app.setLoginItemSettings({ openAtLogin: false })
        const linkPath = startupShortcutPath()
        const exe = process.execPath
        const psCmd = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${linkPath}'); $s.TargetPath='${exe}'; $s.Save()`
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], () => {})
      }
    } catch (err) { console.error('[auto-launch migration]', err) }
  }

  // 시작프로그램 자동 실행 기본값을 켬으로 바꿈 — 딱 한 번만 적용(prefs.autoLaunchDefaultSet로
  // 기록해둠), 그 이후엔 사용자가 설정 메뉴에서 직접 끄고 켜는 걸 존중하고 다시 안 건드림
  if (app.isPackaged) {
    try {
      const prefs = loadPrefs()
      if (!prefs.autoLaunchDefaultSet) {
        if (!fs.existsSync(startupShortcutPath())) {
          const linkPath = startupShortcutPath()
          const exe = process.execPath
          const psCmd = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${linkPath}'); $s.TargetPath='${exe}'; $s.Save()`
          execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], (err) => {
            if (err) console.error('[auto-launch default-on]', err)
          })
        }
        savePrefs({ ...prefs, autoLaunchDefaultSet: true })
      }
    } catch (err) { console.error('[auto-launch default-on]', err) }
  }

  // 실행 시점에 딱 한 번만 조회. 업데이트가 있으면 렌더러가 확인창을 띄움(위 update-available)
  if (app.isPackaged) autoUpdater.checkForUpdates()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
