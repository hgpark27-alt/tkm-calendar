// ===== 로컬 전용 데이터 (구글 캘린더로 절대 안 올라감 — 이 컴퓨터에만 저장) =====
// Electron이면 main 프로세스가 파일로 원자적 저장(Tack 방식), 브라우저 테스트 중이면 localStorage로 대체
let localData = { recentTasks: [], personalTodos: [], personalEvents: [] };

async function loadLocalData() {
  if (window.api?.getLocalData) {
    localData = await window.api.getLocalData();
  } else {
    try { localData = JSON.parse(localStorage.getItem('tkm_localdata') || '{}'); } catch { localData = {}; }
  }
  localData.recentTasks ??= [];
  localData.personalTodos ??= [];
  localData.personalEvents ??= []; // "Personal" 일정 — 구글 캘린더로 절대 안 올라가고 이 컴퓨터에만 저장
}

// 개인 일정 중 특정 달에 속하는 것만 골라서 팀 일정과 같은 모양으로 반환(그리드/일정패널에 같이 섞어 씀).
// 반복 일정(ev.repeat 있음)은 실제로 여러 건 저장하는 대신 매번 그 달 기준으로 펼쳐서 계산함
// (구글 캘린더의 singleEvents:true 확장과 같은 개념, 다만 로컬에서 직접 계산).
function personalEventsForMonth(y, m) {
  const prefix = `${y}-${pad2(m)}`;
  const results = [];
  for (const ev of localData.personalEvents) {
    if (ev.repeat) {
      expandPersonalRepeat(ev, y, m).forEach(date => {
        results.push({
          id: ev.id + '::' + date, seriesId: ev.id, date,
          time: ev.time, allDay: ev.allDay, title: ev.title,
          category: ev.category, author: ev.author, colorId: ev.colorId,
          isPersonal: true, isRecurring: true
        });
      });
    } else if (ev.date.startsWith(prefix)) {
      results.push({ ...ev, isPersonal: true });
    }
  }
  return results;
}

// repeat 패턴을 해당 달 범위 안에서 실제 날짜 목록으로 펼침 — buildRRule(백엔드)이 만드는
// RRULE 문자열을 구글이 해석하는 것과 같은 규칙을 로컬에서 직접 계산한 버전
function expandPersonalRepeat(ev, y, m) {
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0);
  const start = new Date(ev.startDate + 'T00:00:00');
  if (start > monthEnd) return [];
  const until = ev.repeat.until
    ? new Date(ev.repeat.until + 'T23:59:59')
    : new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
  if (until < monthStart) return [];
  const exceptions = new Set(ev.exceptions || []);
  const results = [];

  if (ev.repeat.freq === 'custom') {
    const interval = ev.repeat.intervalDays || 1;
    const cur = new Date(start);
    while (cur <= until && cur <= monthEnd) {
      if (cur >= monthStart) {
        const key = dateKey(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
        if (!exceptions.has(key)) results.push(key);
      }
      cur.setDate(cur.getDate() + interval);
    }
  } else {
    const intervalWeeks = ev.repeat.freq === 'biweekly' ? 2 : 1;
    const byday = (ev.repeat.byday && ev.repeat.byday.length) ? ev.repeat.byday : [WEEKDAY_ABBR[start.getDay()]];
    const startWeekSun = new Date(start);
    startWeekSun.setDate(start.getDate() - start.getDay());
    const rangeStart = start > monthStart ? start : monthStart;
    for (const d = new Date(rangeStart); d <= monthEnd && d <= until; d.setDate(d.getDate() + 1)) {
      const dow = WEEKDAY_ABBR[d.getDay()];
      if (!byday.includes(dow)) continue;
      const weeksSince = Math.floor((d - startWeekSun) / (7 * 86400000));
      if (weeksSince % intervalWeeks !== 0) continue;
      const key = dateKey(d.getFullYear(), d.getMonth() + 1, d.getDate());
      if (!exceptions.has(key)) results.push(key);
    }
  }
  return results;
}
function persistLocalData() {
  if (window.api?.saveLocalData) window.api.saveLocalData(localData);
  else localStorage.setItem('tkm_localdata', JSON.stringify(localData));
}

function trackRecentTask(title) {
  const t = (title || '').trim();
  if (!t) return;
  localData.recentTasks = [t, ...localData.recentTasks.filter(x => x !== t)].slice(0, 4);
  persistLocalData();
}

function renderRecentChips() {
  const wrap = $('#recentChips');
  if (!wrap) return;
  wrap.innerHTML = '';
  localData.recentTasks.forEach(title => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'recent-chip';
    chip.textContent = title;
    chip.title = title;
    chip.addEventListener('click', () => {
      $('#fTitle').value = title;
      onSaveEvent(); // 클릭 한 번으로 바로 저장 — 나머지는 지금 모달의 기본값 그대로
    });
    wrap.appendChild(chip);
  });
  resizeToContent();
}

function renderPersonalTodos() {
  const list = $('#todoList');
  list.innerHTML = '';
  localData.personalTodos.forEach(todo => {
    const li = document.createElement('li');
    li.className = 'todo-item';

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'todo-check' + (todo.done ? ' done' : '');
    check.textContent = todo.done ? '✓' : '';
    check.addEventListener('click', () => toggleTodo(todo.id));
    li.appendChild(check);

    const text = document.createElement('span');
    text.className = 'todo-text' + (todo.done ? ' done' : '');
    text.textContent = todo.text;
    li.appendChild(text);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'todo-del';
    del.textContent = '×';
    del.addEventListener('click', () => deleteTodo(todo.id));
    li.appendChild(del);

    list.appendChild(li);
  });
  resizeToContent();
}

function addPersonalTodo(text) {
  const t = (text || '').trim();
  if (!t) return;
  localData.personalTodos.unshift({ id: 'todo-' + Date.now() + '-' + Math.random().toString(36).slice(2), text: t, done: false });
  persistLocalData();
  renderPersonalTodos();
}
function toggleTodo(id) {
  const item = localData.personalTodos.find(x => x.id === id);
  if (item) item.done = !item.done;
  persistLocalData();
  renderPersonalTodos();
}
function deleteTodo(id) {
  localData.personalTodos = localData.personalTodos.filter(x => x.id !== id);
  persistLocalData();
  renderPersonalTodos();
}

// ===== 설정 =====
const API_URL = 'https://script.google.com/macros/s/AKfycbybOFKkrFU7No0cJS1LG2rKVjXyTWcY5f2vYxEoEAPGWq6ckGBIPGACPcb0PrHP-Hb9yg/exec';
const WIDGET_MAX_H = 700;
// 모달은 내용(반복 필드 펼침 등)에 따라 매번 정확히 측정하려다가 계속 버그가 났음(줌 배율,
// 타이밍 등) — 모달 자체가 이미 max-height:86vh + overflow-y:auto라 넘치면 알아서 스크롤되니,
// 그냥 넉넉한 고정 크기로 열고 모달 안쪽에서 스크롤로 해결함 (측정 안 하니 애초에 틀릴 일이 없음)
const MODAL_FIXED_H = 620;

// 항상 콘텐츠 크기만큼만 창을 차지하게 함(Electron 없으면 조용히 무시됨) — 모달/팝업은
// #app의 형제 요소(position:fixed)라 #app 크기 관찰만으론 못 잡아서 열고닫을 때 직접 호출
// 여백 버그의 진짜 원인: body{zoom:0.8}가 걸려있으면 getBoundingClientRect()/offsetWidth 등은
// 줌이 "적용되기 전"(원래 설계 크기, 1.25배 큰) 좌표계 값을 돌려줌 — 반면 window.innerWidth/
// innerHeight는 실제 줌 적용된(진짜 화면) 좌표계임. 이 둘을 그냥 섞어 써서 창이 항상 실제
// 필요한 크기의 1.25배로 큼직하게 잡혔던 게 원인 (실측: #app.offsetWidth=304인데
// window.innerWidth=243, 304/243=1.25=1/0.8 — 정확히 일치). #app 쪽은 이 보정을 그대로 씀.
// 폭은 이제 우하단 핸들로 사용자가 직접 조절함(main/index.js resizable:true) — 여기서는
// "지금 창의 실제 폭"을 그대로 유지하면서 높이만 내용에 맞게 다시 잡음. WIDGET_W 같은 고정값을
// 쓰면 사용자가 넓혀놓은 폭을 매번 되돌려버리게 되므로 반드시 window.innerWidth를 그대로 씀
function resizeToContent() {
  const currentW = window.innerWidth;
  if ($('#modalBackdrop')?.classList.contains('open') || $('#recurringBackdrop')?.classList.contains('open')) {
    window.api?.resize?.(currentW, MODAL_FIXED_H);
    return;
  }
  // getBoundingClientRect는 소수점까지 정확 — scrollHeight(정수 반올림)로는
  // 6주짜리 달(그리드 6행)에서 반올림 오차가 누적돼 마지막 행이 잘리는 문제가 있었음
  const target = document.getElementById('app').getBoundingClientRect().height;
  // CSS의 zoom 값을 하드코딩하지 않고 실제 계산된 값을 읽어서 곱함 — 나중에 zoom 값이
  // 바뀌어도 여기 코드를 따로 안 고쳐도 항상 맞게 동작함
  const bodyZoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
  const zoomedTarget = target * bodyZoom;
  const requestedH = Math.min(Math.ceil(Math.max(zoomedTarget, 120)) + 6, WIDGET_MAX_H);
  window.api?.resize?.(currentW, requestedH);
}

const DOT_COLOR = { // colorId → CSS 변수 (style.css의 --c1~--c11과 매칭)
  '1':'--c1','2':'--c2','3':'--c3','4':'--c4','5':'--c5','6':'--c6',
  '7':'--c7','8':'--c8','9':'--c9','10':'--c10','11':'--c11'
};
// 카테고리 지정 안 한 일정은 흰 점(테두리만) — 실제 카테고리가 있는 경우만 색 채움
function dotStyle(dot, ev) {
  if (!ev.category) dot.classList.add('dot-none');
  else dot.style.background = `var(${DOT_COLOR[ev.colorId] || '--c8'})`;
}

// ===== 상태 =====
const state = {
  year: 2026, month: 7,     // 서버 시간 기준으로 init()에서 즉시 갱신됨
  selectedDate: null,       // 'YYYY-MM-DD'
  events: [],               // 이번 달 이벤트 전체
  categories: {},           // { '미팅': '9', ... } — 백엔드에서 로드
  loadedYear: null, loadedMonth: null, // 마지막으로 실제 로드 완료한 달 (같은 달 재동기화 시 깜빡임 방지용)
  editingId: null,          // null이면 추가 모드, 값이 있으면 그 이벤트를 수정 중
  editingIsPersonal: false, // 수정 중인 이벤트가 Personal(로컬 전용)인지 Team Post(구글 캘린더)인지
  viewMode: 'simple',       // 'simple' | 'max'
  dayPanelCollapsed: false, // 최대 모드에서만 의미 있음 (간단 모드는 항상 펼침)
};

const $ = (sel) => document.querySelector(sel);
const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const todayKey = () => { const d = new Date(); return dateKey(d.getFullYear(), d.getMonth()+1, d.getDate()); };

const WEEKDAY_ABBR = ['SU','MO','TU','WE','TH','FR','SA'];
const MONTH_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEKDAY_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const weekdayOf = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAY_ABBR[new Date(y, m - 1, d).getDay()];
};

// ===== 대한민국 공휴일 (프론트에서 표시용 — 구글 캘린더(우리 팀 일정) 데이터엔 전혀 영향 없음) =====
// 구글이 공개 제공하는 "대한민국의 휴일" 캘린더(ICS)를 백엔드에서 받아와 덮어씀(init() 참고) —
// 설날/추석/부처님오신날처럼 음력 기준이라 매년 손으로 넣기 번거로운 날짜까지 자동으로 반영됨.
// 아래 값은 그 요청이 실패하거나(네트워크 문제 등) 아직 안 끝났을 때 쓰는 폴백 겸 초기값.
let KR_HOLIDAYS = {
  '2026-01-01': '신정',
  '2026-02-16': '설날 연휴',
  '2026-02-17': '설날',
  '2026-02-18': '설날 연휴',
  '2026-03-01': '삼일절',
  '2026-03-02': '대체공휴일 (삼일절)',
  '2026-05-05': '어린이날',
  '2026-05-24': '부처님오신날',
  '2026-05-25': '대체공휴일 (부처님오신날)',
  '2026-06-06': '현충일',
  '2026-08-15': '광복절',
  '2026-08-17': '대체공휴일 (광복절)',
  '2026-09-24': '추석 연휴',
  '2026-09-25': '추석',
  '2026-09-26': '추석 연휴',
  '2026-10-03': '개천절',
  '2026-10-05': '대체공휴일 (개천절)',
  '2026-10-09': '한글날',
  '2026-12-25': '크리스마스',
  '2027-01-01': '신정',
  '2027-02-06': '설날 연휴',
  '2027-02-07': '설날',
  '2027-02-08': '설날 연휴',
  '2027-02-09': '대체공휴일 (설날)',
  '2027-03-01': '삼일절',
  '2027-05-05': '어린이날',
  '2027-05-13': '부처님오신날',
  '2027-06-06': '현충일',
  '2027-08-15': '광복절',
  '2027-08-16': '대체공휴일 (광복절)',
  '2027-09-24': '추석 연휴',
  '2027-09-25': '추석',
  '2027-09-26': '추석 연휴',
  '2027-10-03': '개천절',
  '2027-10-04': '대체공휴일 (개천절)',
  '2027-10-09': '한글날',
  '2027-10-11': '대체공휴일 (한글날)',
  '2027-12-25': '크리스마스',
  '2027-12-27': '대체공휴일 (크리스마스)',
};

// ===== API 호출 =====
async function apiGet(params) {
  // 조회 URL이 매번 동일해서 브라우저가 캐시된 응답을 재사용할 수 있음 — 매 호출 고유 값으로 무효화
  const q = new URLSearchParams({ ...params, _: Date.now() }).toString();
  const r = await fetch(`${API_URL}?${q}`, { cache: 'no-store' });
  return r.json();
}
async function apiPost(body) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // CORS preflight 회피
    body: JSON.stringify(body)
  });
  return r.json();
}

function setHint(msg, type) {
  const el = $('#formHint');
  el.textContent = msg;
  el.className = 'hint' + (type ? ' ' + type : '');
}

// ===== 테마 =====
const THEMES = ['light', 'dark', 'tack'];
function applyTheme(theme) {
  if (theme === 'light') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  document.querySelectorAll('.popover-item[data-theme]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}
function loadTheme() {
  const saved = localStorage.getItem('tkm_theme');
  applyTheme(THEMES.includes(saved) ? saved : 'light');
}

// ===== 보기 모드 (간단/최대) =====
function applyViewMode(mode) {
  state.viewMode = mode;
  state.dayPanelCollapsed = (mode === 'max'); // 최대 모드는 기본 접힘, 간단 모드는 항상 펼침
  document.querySelectorAll('.popover-item[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });
  $('#dayPanelToggle').hidden = (mode !== 'max');
  updateDayPanelVisibility();
  renderGrid();
}
function loadViewMode() {
  const saved = localStorage.getItem('tkm_viewmode');
  applyViewMode(saved === 'max' ? 'max' : 'simple');
}
function updateDayPanelVisibility() {
  const collapsed = state.viewMode === 'max' && state.dayPanelCollapsed;
  $('#dayPanel').classList.toggle('collapsed', collapsed);
  $('#dayPanelToggle').textContent = collapsed ? 'Show list ▾' : 'Hide ▴';
}

// ===== 초기화 =====
async function init() {
  const now = new Date();
  state.year = now.getFullYear();
  state.month = now.getMonth() + 1;
  state.selectedDate = todayKey();

  loadTheme();
  loadViewMode();
  bindEvents(); // 네트워크 기다리지 않고 바로 상호작용 가능하게

  // 로컬 전용 데이터(최근 업무, 개인 할일) — 네트워크 필요 없이 바로 로드
  await loadLocalData();
  renderPersonalTodos();

  window.api?.getAutoLaunch?.().then(on => {
    $('#autoLaunchBtn')?.classList.toggle('active', !!on);
  });

  // Tack처럼 위젯 창이 포커스를 잃으면 열려있던 모달/팝업을 정리하고 달력만 남김
  window.api?.onBlur?.(closeAllOverlaysOnBlur);
  // 포커스를 얻는 것 자체(win-focus)로는 안 펼침 — 손잡이(타이틀바)를 눌러서 창을 옮기기만 해도
  // OS 포커스는 얻어지기 때문에, 펼치는 건 "타이틀바 밖을 실제로 클릭했을 때"로만 판단함
  document.addEventListener('click', (e) => {
    const app = document.getElementById('app');
    if (!app.classList.contains('unfocused')) return;
    if (e.target.closest('.title-bar')) return; // 손잡이 한 번 클릭/드래그는 이동만, 펼치지 않음
    if (e.target.closest('.todo-check') || e.target.closest('.todo-del')) return; // 체크박스/삭제만 접힌 채로 처리, My Notes 나머지 부분은 눌러도 펼쳐짐
    restoreOverlaysOnFocus();
  });
  // 손잡이(상단부)는 더블클릭하면 펼쳐짐 — maximizable:false로 막아놔서 이제 Windows가
  // 더블클릭을 최대화 제스처로 가로채지 않으니 일반 dblclick이 정상적으로 들어옴
  $('.title-bar').addEventListener('dblclick', () => {
    const app = document.getElementById('app');
    if (app.classList.contains('unfocused')) restoreOverlaysOnFocus();
  });
  // #app 크기가 바뀔 때마다(그리드/일정목록 등 무엇이 원인이든) 자동으로 창 크기 맞춤
  let resizeRaf = null;
  new ResizeObserver(() => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = null; resizeToContent(); });
  }).observe(document.getElementById('app'));

  // 카테고리는 백그라운드 로드 — "+" 모달 열기 전까지는 필요 없음
  apiGet({ action: 'categories' }).then(catRes => {
    if (catRes.ok) state.categories = catRes.categories;
  });

  // 공휴일도 백그라운드 로드 — 받아오면 위에 넣어둔 폴백 값을 덮어쓰고 다시 그림
  apiGet({ action: 'holidays' }).then(holRes => {
    if (holRes.ok && holRes.holidays) {
      KR_HOLIDAYS = { ...KR_HOLIDAYS, ...holRes.holidays };
      renderGrid();
    }
  });

  // 다른 팀원이 네이티브 캘린더에서 바꾼 내용을 자동 반영 — 진짜 웹훅 대신 가벼운 폴링/포커스 갱신
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadMonth();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') loadMonth();
  }, 120000); // Apps Script 일일 실행시간 할당량 여유를 위해 2분 간격

  await loadMonth();
}

function renderAll() {
  renderMonthTitle();
  renderGrid();
  renderDayPanel();
  // 초기 로드 시 폰트/zoom/레이아웃이 아직 다 안정되기 전에 측정되면 실제보다 크게 잡혀서
  // (심하면 WIDGET_MAX_H 상한까지 붙어버림) 그 뒤로 아무도 다시 줄여주지 않는 문제가 있었음 —
  // 여러 타이밍에 걸쳐 반복 재측정해서 마지막 값이 항상 실제 크기로 맞춰지게 함
  resettleSize();
}

// 달 단위 캐시 — 한 번 본 달은 재방문 시 네트워크 기다리지 않고 즉시 표시,
// 백그라운드에서 조용히 재검증만 함(다른 사람이 바꾼 내용 반영). 이동할 때마다
// 매번 새로 받아오던 이전 방식이 버벅거림의 원인이었음.
const monthCache = new Map(); // 'YYYY-M' → events[]
let loadToken = 0; // 그 사이 다른 달로 이동하면 늦게 도착한 응답을 버리기 위한 토큰

function monthKey(y, m) { return `${y}-${m}`; }

async function loadMonth() {
  const myToken = ++loadToken;
  const y = state.year, m = state.month;
  const key = monthKey(y, m);

  const cached = monthCache.get(key);
  if (cached) {
    state.events = cached; // 캐시 있으면 네트워크 없이 즉시 표시
  } else if (state.loadedYear !== y || state.loadedMonth !== m) {
    state.events = []; // 처음 보는 달이라 어쩔 수 없이 비워서 표시(다른 달 점이 잘못 보이는 것 방지)
  }
  state.loadedYear = y; state.loadedMonth = m;
  renderAll();

  const res = await apiGet({ action: 'list', year: y, month: m });
  if (myToken !== loadToken) return; // 응답 오는 사이 다른 달로 이동함 — 이 결과는 폐기
  if (res.ok) {
    monthCache.set(key, res.events);
    state.events = res.events;
    renderAll();
  }

  prefetchAdjacentMonths(y, m);
}

function prefetchAdjacentMonths(y, m) {
  const prev = m <= 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  const next = m >= 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  [prev, next].forEach(({ y: py, m: pm }) => {
    const key = monthKey(py, pm);
    if (monthCache.has(key)) return; // 이미 있으면 다시 안 받음
    apiGet({ action: 'list', year: py, month: pm }).then(res => {
      if (res.ok) monthCache.set(key, res.events);
    });
  });
}

// ===== 렌더링: 상단 타이틀 =====
function renderMonthTitle() {
  $('#monthTitle').textContent = `${MONTH_EN[state.month - 1]} ${state.year}`;
}

// 날짜 위에 마우스 올리면 바로(지연 없이) 뜨는 일정/공휴일 미리보기 — 드롭다운처럼
function showHoverTip(cellEl, events, holidayName) {
  const tip = $('#hoverTip');
  tip.innerHTML = '';
  if (holidayName) {
    const row = document.createElement('div');
    row.className = 'hover-tip-holiday';
    row.textContent = holidayName;
    tip.appendChild(row);
  }
  events.slice(0, 6).forEach(ev => {
    const row = document.createElement('div');
    row.className = 'hover-tip-row';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dotStyle(dot, ev);
    row.appendChild(dot);
    const title = document.createElement('span');
    title.className = 'hover-tip-title';
    title.textContent = ev.title;
    row.appendChild(title);
    if (!ev.allDay && ev.time) {
      const time = document.createElement('span');
      time.className = 'hover-tip-time';
      time.textContent = ev.time;
      row.appendChild(time);
    }
    tip.appendChild(row);
  });
  if (events.length > 6) {
    const more = document.createElement('div');
    more.className = 'hover-tip-more';
    more.textContent = `+${events.length - 6} more`;
    tip.appendChild(more);
  }
  tip.classList.add('open');

  // 좁은 위젯 폭 안에서만 보이게 위치 clamp — 셀 아래쪽 우선, 공간 없으면 위쪽
  const cellRect = cellEl.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = cellRect.left + cellRect.width / 2 - tipRect.width / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
  // 아래로 열면 마우스 커서가 미리보기를 가려서 위쪽을 우선으로 함 — 위쪽 공간 부족할 때만 아래로
  let top = cellRect.top - tipRect.height - 4;
  if (top < 4) top = cellRect.bottom + 4;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideHoverTip() {
  $('#hoverTip').classList.remove('open');
}

// ===== 렌더링: 월간 그리드 =====
function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  hideHoverTip(); // 그리드가 다시 그려지면(달 이동 등) 떠 있던 미리보기는 정리
  grid.className = 'grid mode-' + state.viewMode;

  const firstDow = new Date(state.year, state.month - 1, 1).getDay(); // 0=일
  const daysInMonth = new Date(state.year, state.month, 0).getDate();
  const daysInPrevMonth = new Date(state.year, state.month - 1, 0).getDate();

  const eventsByDate = {};
  for (const ev of [...state.events, ...personalEventsForMonth(state.year, state.month)]) {
    (eventsByDate[ev.date] ??= []).push(ev);
  }

  const cells = [];
  // 이전 달 채우기
  for (let i = firstDow - 1; i >= 0; i--) {
    cells.push({ day: daysInPrevMonth - i, outside: true });
  }
  // 이번 달
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, outside: false });
  }
  // 다음 달로 6주(42칸) 채우기
  let next = 1;
  while (cells.length < 42) cells.push({ day: next++, outside: true, isNext: true });

  const tKey = todayKey();

  cells.forEach(cellInfo => {
    const div = document.createElement('div');
    div.className = 'cell';

    let key;
    if (cellInfo.outside && !cellInfo.isNext) {
      const pm = state.month - 1 <= 0 ? 12 : state.month - 1;
      const py = state.month - 1 <= 0 ? state.year - 1 : state.year;
      key = dateKey(py, pm, cellInfo.day);
      div.classList.add('outside');
    } else if (cellInfo.outside && cellInfo.isNext) {
      const nm = state.month + 1 > 12 ? 1 : state.month + 1;
      const ny = state.month + 1 > 12 ? state.year + 1 : state.year;
      key = dateKey(ny, nm, cellInfo.day);
      div.classList.add('outside');
    } else {
      key = dateKey(state.year, state.month, cellInfo.day);
      const dow = new Date(state.year, state.month - 1, cellInfo.day).getDay();
      if (dow === 0) div.classList.add('sun');
      if (dow === 6) div.classList.add('sat');
    }

    if (key === tKey) div.classList.add('today');
    if (key === state.selectedDate) div.classList.add('selected');

    const holidayName = !cellInfo.outside ? KR_HOLIDAYS[key] : null; // 지난달/다음달 칸은 회색 유지
    if (holidayName) {
      div.classList.add('holiday');
      div.title = holidayName; // 네이티브 툴팁(빠른 확인용) — 아래 mouseenter 미리보기도 같이 표시
    }

    const num = document.createElement('div');
    num.className = 'daynum';
    num.textContent = cellInfo.day;
    div.appendChild(num);

    const dayEvents = eventsByDate[key] || [];
    if (dayEvents.length) {
      if (state.viewMode === 'max') {
        const chipsWrap = document.createElement('div');
        chipsWrap.className = 'chips-wrap';
        dayEvents.slice(0, 3).forEach(ev => {
          const row = document.createElement('div');
          row.className = 'chip-row';
          const dot = document.createElement('span');
          dot.className = 'dot';
          dotStyle(dot, ev);
          const text = document.createElement('span');
          text.className = 'chip-text';
          text.textContent = ev.title;
          row.append(dot, text);
          chipsWrap.appendChild(row);
        });
        if (dayEvents.length > 3) {
          const more = document.createElement('div');
          more.className = 'chip-more';
          more.textContent = `+${dayEvents.length - 3} more`;
          chipsWrap.appendChild(more);
        }
        div.appendChild(chipsWrap);
      } else {
        const dotsWrap = document.createElement('div');
        dotsWrap.className = 'dots';
        dayEvents.slice(0, 3).forEach(ev => {
          const dot = document.createElement('span');
          dot.className = 'dot';
          dotStyle(dot, ev);
          dotsWrap.appendChild(dot);
        });
        if (dayEvents.length > 3) {
          const more = document.createElement('span');
          more.className = 'dot-more';
          more.textContent = `+${dayEvents.length - 3}`;
          dotsWrap.appendChild(more);
        }
        div.appendChild(dotsWrap);
      }
    }

    // 접힘 모드에서만 마우스 올리면 미리보기 — 펼친 상태에선 클릭하면 바로 아래 일정 패널이
    // 열리니 호버 미리보기가 굳이 필요 없음. renderGrid가 다른 시점(포커스 복귀 등)에 다시
    // 안 불려도 항상 최신 상태를 반영하도록 리스너 안에서 그때그때 판단함
    if (holidayName || dayEvents.length) {
      div.addEventListener('mouseenter', () => {
        const collapsed = document.getElementById('app').classList.contains('unfocused');
        if (!collapsed) return;
        const tipEvents = state.viewMode === 'simple' ? dayEvents : [];
        showHoverTip(div, tipEvents, holidayName);
      });
      div.addEventListener('mouseleave', hideHoverTip);
    }

    div.addEventListener('click', () => {
      state.selectedDate = key;
      if (state.viewMode === 'max') {
        state.dayPanelCollapsed = false; // 날짜 클릭하면 자세히 보기 자동으로 펼침
        updateDayPanelVisibility();
      }
      renderGrid();
      renderDayPanel();
    });

    div.addEventListener('dblclick', () => {
      state.selectedDate = key; // openAddModal이 이 값을 날짜 기본값으로 사용
      openAddModal();
    });

    grid.appendChild(div);
  });
}

// ===== 렌더링: 하단 일정 패널 =====
function renderDayPanel() {
  const label = $('#selectedDateLabel');
  const list = $('#eventList');
  list.innerHTML = '';

  if (!state.selectedDate) {
    label.textContent = 'Select a date';
    return;
  }

  const [y, m, d] = state.selectedDate.split('-').map(Number);
  const dow = WEEKDAY_EN[new Date(y, m-1, d).getDay()];
  label.textContent = `${dow}, ${MONTH_EN[m - 1]} ${d}`;

  const dayEvents = [...state.events, ...personalEventsForMonth(state.year, state.month)]
    .filter(ev => ev.date === state.selectedDate);
  if (!dayEvents.length) {
    // 안내 문구 대신 그냥 비워둠 — 창 높이가 자동으로 그만큼 줄어듦
    return;
  }

  dayEvents.forEach(ev => {
    const li = document.createElement('li');
    li.className = 'event-row clickable';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dotStyle(dot, ev);
    li.appendChild(dot);

    const body = document.createElement('div');
    body.className = 'event-body';

    const title = document.createElement('span');
    title.className = 'event-title';
    title.textContent = ev.title;
    body.appendChild(title);

    // 둘째 줄: 시간(있으면 강조색) · 카테고리 · 작성자 · 반복표시
    const meta = document.createElement('span');
    meta.className = 'event-meta';
    if (!ev.allDay && ev.time) {
      const timeEl = document.createElement('span');
      timeEl.className = 'event-time';
      timeEl.textContent = ev.time;
      meta.appendChild(timeEl);
    }
    const rest = [ev.isPersonal ? 'Personal' : null, ev.category, ev.author, ev.isRecurring ? '↻ 반복' : ''].filter(Boolean).join(' · ');
    if (rest) meta.appendChild(document.createTextNode((!ev.allDay && ev.time ? ' · ' : '') + rest));
    body.appendChild(meta);

    li.appendChild(body);

    const addNote = document.createElement('button');
    addNote.type = 'button';
    addNote.className = 'event-addnote';
    addNote.title = 'Add to My Notes';
    addNote.textContent = '+ Add';
    addNote.addEventListener('click', (e) => {
      e.stopPropagation();
      addPersonalTodo(ev.title);
    });
    li.appendChild(addNote);

    const del = document.createElement('button');
    del.className = 'event-del';
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(ev); });
    li.appendChild(del);

    li.addEventListener('click', () => openEditModal(ev));

    list.appendChild(li);
  });
}

// ===== 삭제 =====
async function onDelete(ev) {
  if (!safeConfirm(`"${ev.title}" 일정을 삭제할까요?`)) return;

  if (ev.isPersonal) {
    if (ev.isRecurring) {
      const deleteSeries = safeConfirm('반복 일정입니다.\n확인 = 반복 전체 삭제\n취소 = 이 날짜만 삭제');
      if (deleteSeries) {
        localData.personalEvents = localData.personalEvents.filter(e => e.id !== ev.seriesId);
      } else {
        const series = localData.personalEvents.find(e => e.id === ev.seriesId);
        if (series) { series.exceptions ??= []; series.exceptions.push(ev.date); }
      }
    } else {
      localData.personalEvents = localData.personalEvents.filter(e => e.id !== ev.id);
    }
    persistLocalData();
    renderGrid();
    renderDayPanel();
    return;
  }

  const myName = localStorage.getItem('tkm_username') || '';
  if (ev.author && myName && ev.author.trim() !== myName.trim()) {
    if (!safeConfirm(`이 일정은 "${ev.author}"님이 등록했습니다. 그래도 삭제하시겠어요?`)) return;
  }

  let deleteSeries = false;
  if (ev.isRecurring) {
    deleteSeries = safeConfirm('반복 일정입니다.\n확인 = 반복 전체 삭제\n취소 = 이 날짜만 삭제');
  }

  // 낙관적 삭제 — 서버 응답 기다리지 않고 화면에서 바로 제거, 실패하면 되돌림
  const matchKey = ev.recurringEventId || ev.id;
  const removed = deleteSeries
    ? state.events.filter(e => (e.recurringEventId || e.id) === matchKey)
    : state.events.filter(e => e.id === ev.id);
  state.events = state.events.filter(e => !removed.includes(e));
  renderGrid();
  renderDayPanel();

  let res;
  try {
    res = await apiPost({ action: 'delete', eventId: ev.id, deleteSeries });
  } catch (err) {
    res = { ok: false, error: err.message || '네트워크 오류' };
  }

  if (!res.ok) {
    state.events.push(...removed); // 롤백
    renderGrid();
    renderDayPanel();
    safeAlert('삭제 실패: ' + res.error);
    return;
  }

  await loadMonth(); // 성공 — 같은 달이면 loadMonth가 깜빡임 없이 조용히 재동기화
}

// ===== 추가/수정 모달 =====
function renderCatChips(activeCategory) {
  const wrap = $('#catChips');
  wrap.innerHTML = '';

  // 아무 카테고리도 지정 안 한 상태 — 흰 점, 기본값
  const noneChip = document.createElement('button');
  noneChip.type = 'button';
  noneChip.className = 'chip' + (!activeCategory ? ' active' : '');
  noneChip.dataset.cat = '';
  noneChip.innerHTML = `<span class="dot dot-none"></span>None`;
  noneChip.addEventListener('click', () => {
    wrap.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    noneChip.classList.add('active');
  });
  wrap.appendChild(noneChip);

  Object.entries(state.categories).forEach(([name, colorId]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    const isActive = activeCategory === name;
    chip.className = 'chip' + (isActive ? ' active' : '');
    chip.dataset.cat = name;
    chip.innerHTML = `<span class="dot" style="background:var(${DOT_COLOR[colorId] || '--c8'})"></span>${name}`;
    chip.addEventListener('click', () => {
      wrap.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
    wrap.appendChild(chip);
  });
}

function openAddModal() {
  state.editingId = null;
  state.editingIsPersonal = false;
  $('#modalTitle').textContent = 'Add Event';
  $('#fDate').value = state.selectedDate || todayKey();
  $('#fTime').value = ''; // 비워두면 하루종일 — 억지로 기본 시간을 채우지 않음
  $('#fTitle').value = '';
  $('#fAuthor').value = localStorage.getItem('tkm_username') || '';
  $('#fRepeat').value = 'none';
  $('#fIntervalDays').value = 3;
  $('#fUntil').value = '';
  setScopeToggle('personal', false); // 필수 선택, 기본값 Personal
  $('#repeatRow').hidden = false; // Personal/Team Post 둘 다 반복 지원
  $('#biweeklyRow').hidden = true;
  $('#customRow').hidden = true;
  $('#untilRow').hidden = true;
  setHint('');
  renderCatChips();
  renderRecentChips();
  $('#weekdayPicker').querySelectorAll('button').forEach(b => b.classList.remove('active'));
  $('#modalBackdrop').classList.add('open');
  resizeToContent();
}

// Personal/Team Post 토글 — 수정 중일 땐 저장소를 옮기는 복잡도를 피하려고 고정(locked)해둠
function setScopeToggle(scope, locked) {
  const wrap = $('#scopeToggle');
  wrap.classList.toggle('locked', !!locked);
  wrap.querySelectorAll('.scope-btn').forEach(b => b.classList.toggle('active', b.dataset.scope === scope));
}

function openEditModal(ev) {
  // Personal 반복 일정은 화면에 펼쳐진 특정 발생일(가짜 id)이 아니라 원본 시리즈(seriesId)를 수정함
  state.editingId = (ev.isPersonal && ev.isRecurring) ? ev.seriesId : ev.id;
  state.editingIsPersonal = !!ev.isPersonal;
  $('#modalTitle').textContent = 'Edit Event';
  $('#fDate').value = ev.date;
  $('#fTime').value = ev.allDay ? '' : (ev.time || '');
  $('#fTitle').value = ev.title;
  $('#fAuthor').value = ev.author || '';
  setScopeToggle(ev.isPersonal ? 'personal' : 'team', true);
  // 수정 모드에서는 반복 패턴 자체는 바꾸지 않음(복잡도 방지) — 삭제 후 재등록으로 안내
  $('#repeatRow').hidden = true;
  $('#biweeklyRow').hidden = true;
  $('#customRow').hidden = true;
  $('#untilRow').hidden = true;
  let hint = '';
  if (ev.isRecurring) {
    hint = ev.isPersonal
      ? 'Recurring event — changes apply to the whole series. (To change the repeat pattern, delete and re-add.)'
      : 'Recurring event — only this date will be changed. (To change the repeat pattern, delete and re-add.)';
  }
  setHint(hint, 'info');
  renderCatChips(ev.category);
  $('#recentChips').innerHTML = ''; // 수정 모드에서는 최근 업무 추천 안 보여줌
  $('#modalBackdrop').classList.add('open');
  resizeToContent();
}

// 반복 유형이 '매주'/'격주'가 됐을 때, 아직 아무 요일도 안 골랐으면 선택한 날짜의 요일을 기본 체크
function preselectWeekdayIfEmpty() {
  const picker = $('#weekdayPicker');
  if (picker.querySelectorAll('button.active').length) return; // 이미 골라둔 게 있으면 안 건드림
  const dow = weekdayOf($('#fDate').value || todayKey());
  const btn = picker.querySelector(`button[data-day="${dow}"]`);
  if (btn) btn.classList.add('active');
}
function closeAddModal() { $('#modalBackdrop').classList.remove('open'); resizeToContent(); }
function closePopover() {
  $('#settingsPopover').classList.remove('open');
  $('#popoverBackdrop').classList.remove('open');
  resizeToContent();
}
// display:none 전환 직후엔 브라우저 레이아웃이 한 프레임 늦게 안정되는 경우가 있어서(6주짜리
// 그리드에서 겪었던 것과 같은 종류) 여러 타이밍에 걸쳐 반복 재측정 — 접힘/펼침 직후 여백이
// 남거나 창이 덜 줄어드는 문제 방지
function resettleSize() {
  resizeToContent();
  requestAnimationFrame(() => requestAnimationFrame(resizeToContent));
  setTimeout(resizeToContent, 60);
  setTimeout(resizeToContent, 200);
}

// confirm()/alert()는 Electron에서 네이티브 대화상자라 뜨는 순간 창이 blur됨 —
// "삭제할까요?" 확인창에 답했을 뿐인데 접힘모드로 착각해서 오늘 날짜로 튕기는 문제가 있었음.
// 대화상자를 띄우기 직전/직후에 이 플래그를 켜서, 그 사이에 들어오는 blur는 무시함.
let suppressBlurCollapse = false;
function safeConfirm(msg) {
  suppressBlurCollapse = true;
  const result = confirm(msg);
  setTimeout(() => { suppressBlurCollapse = false; }, 150); // 지연된 blur 이벤트가 뒤늦게 도착하는 경우 대비
  return result;
}
function safeAlert(msg) {
  suppressBlurCollapse = true;
  alert(msg);
  setTimeout(() => { suppressBlurCollapse = false; }, 150);
}

// Tack처럼 창이 포커스를 잃으면 열려있던 모달/팝업/반복관리 창을 닫고,
// 일정 목록은 접고(My Notes 체크리스트는 유지) 오늘 날짜·오늘 달로 돌아감
function closeAllOverlaysOnBlur() {
  if (suppressBlurCollapse) return; // 우리 자신의 confirm()/alert() 때문에 뜬 blur — 무시
  if ($('#modalBackdrop').classList.contains('open')) closeAddModal();
  if ($('#recurringBackdrop').classList.contains('open')) { $('#recurringBackdrop').classList.remove('open'); resizeToContent(); }
  closePopover();
  hideHoverTip();

  document.getElementById('app').classList.add('unfocused');
  state.selectedDate = todayKey();

  const now = new Date();
  if (state.year !== now.getFullYear() || state.month !== now.getMonth() + 1) {
    state.year = now.getFullYear();
    state.month = now.getMonth() + 1;
    loadMonth(); // renderAll()이 그리드/패널을 다시 그리고 창 크기까지 맞춰줌(캐시 있으면 네트워크 없이 즉시)
  } else {
    renderGrid();
    renderDayPanel();
  }
  resettleSize();
}
// 창이 다시 포커스를 얻으면(클릭해서 돌아옴) 접어뒀던 걸 원래대로 펼침
function restoreOverlaysOnFocus() {
  document.getElementById('app').classList.remove('unfocused');
  resettleSize();
}

// 모달의 반복 필드를 읽어서 { freq, byday?, intervalDays?, until? } 형태로 변환 —
// Personal(로컬 확장)/Team Post(구글 RRULE) 둘 다 같은 입력값에서 출발
function readRepeatFromForm() {
  const repeatType = $('#fRepeat').value;
  if (repeatType === 'none') return { repeat: null };
  const repeat = { freq: repeatType };
  if (repeatType === 'weekly' || repeatType === 'biweekly') {
    const days = [...$('#weekdayPicker').querySelectorAll('button.active')].map(b => b.dataset.day);
    if (!days.length) return { repeat: null, error: 'Please select at least one day.' };
    repeat.byday = days;
  }
  if (repeatType === 'custom') {
    repeat.intervalDays = parseInt($('#fIntervalDays').value, 10) || 1;
  }
  const until = $('#fUntil').value;
  if (until) repeat.until = until;
  return { repeat };
}

async function onSaveEvent() {
  const title = $('#fTitle').value.trim();
  const date = $('#fDate').value;
  const time = $('#fTime').value; // '' 이면 하루종일
  const author = $('#fAuthor').value.trim();
  const activeChip = $('#catChips .chip.active');
  const category = activeChip ? activeChip.dataset.cat : '';

  if (!title) { setHint('Please enter a title.', 'error'); return; }
  if (!date)  { setHint('Please select a date.', 'error'); return; }

  if (author) localStorage.setItem('tkm_username', author);

  const scopeBtn = $('#scopeToggle .scope-btn.active');
  const isPersonal = state.editingId ? state.editingIsPersonal : (scopeBtn?.dataset.scope !== 'team');

  if (state.editingId) {
    if (isPersonal) saveEditPersonal(state.editingId, { title, date, time: time || null, category, author });
    else await saveEdit(state.editingId, { title, date, time: time || null, category, author });
    return;
  }

  const { repeat, error } = readRepeatFromForm();
  if (error) { setHint(error, 'error'); return; }

  if (isPersonal) {
    saveNewPersonal({ title, date, time: time || null, category, author, repeat });
    return;
  }

  // 낙관적 업데이트 — 서버 응답 기다리지 않고 화면에 바로 반영, 저장은 백그라운드에서 진행
  const tempId = 'temp-' + Date.now();
  const optimistic = {
    id: tempId, recurringEventId: null, isRecurring: !!repeat,
    title, date, time: time || null, allDay: !time,
    category, author, colorId: state.categories[category] || '8'
  };
  state.events.push(optimistic);
  state.selectedDate = date;
  closeAddModal(); // 모달 닫힘 처리(그 시점의 #app 크기로 1차 리사이즈) 직후에 아래에서 내용이 또 바뀌므로
  renderGrid();
  renderDayPanel();
  resettleSize(); // 방금 추가된 일정이 반영된 "진짜" 최종 크기로 다시 맞춤 — ResizeObserver에만 기대지 않음

  let res;
  try {
    res = await apiPost({ action: 'add', title, date, time: time || null, category, author, repeat });
  } catch (err) {
    res = { ok: false, error: err.message || '네트워크 오류' };
  }

  if (!res.ok) {
    // 실패 — 방금 넣은 낙관적 항목만 롤백
    state.events = state.events.filter(e => e.id !== tempId);
    renderGrid();
    renderDayPanel();
    safeAlert('저장 실패: ' + res.error);
    return;
  }

  trackRecentTask(title);
  // 성공 — 실제 서버 상태로 재동기화(반복 일정이면 다른 달 확장분까지 정확히 반영됨)
  await loadMonth();
}

// ===== 수정 저장 (낙관적 업데이트 + 실패 시 롤백) =====
async function saveEdit(id, fields) {
  const idx = state.events.findIndex(e => e.id === id);
  const prev = idx >= 0 ? { ...state.events[idx] } : null;

  if (idx >= 0) {
    state.events[idx] = {
      ...state.events[idx],
      title: fields.title, date: fields.date,
      time: fields.time, allDay: !fields.time,
      category: fields.category, author: fields.author,
      colorId: state.categories[fields.category] || '8'
    };
  }
  closeAddModal();
  renderGrid();
  renderDayPanel();
  resettleSize();

  let res;
  try {
    res = await apiPost({ action: 'update', eventId: id, ...fields });
  } catch (err) {
    res = { ok: false, error: err.message || '네트워크 오류' };
  }

  if (!res.ok) {
    if (prev && idx >= 0) state.events[idx] = prev; // 롤백
    renderGrid();
    renderDayPanel();
    safeAlert('수정 실패: ' + res.error);
    return;
  }

  await loadMonth();
}

// ===== Personal 일정 저장/수정 (로컬 전용 — 네트워크 없이 바로 반영, 반복 미지원) =====
function saveNewPersonal({ title, date, time, category, author, repeat }) {
  const ev = {
    id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    title, time, allDay: !time,
    category, author, colorId: state.categories[category] || '8'
  };
  if (repeat) {
    ev.repeat = repeat;
    ev.startDate = date;
    ev.exceptions = [];
  } else {
    ev.date = date;
  }
  localData.personalEvents.push(ev);
  persistLocalData();
  state.selectedDate = date;
  closeAddModal();
  renderGrid();
  renderDayPanel();
  resettleSize();
  trackRecentTask(title);
}

// 반복 일정 수정은 시리즈 전체(id 그대로, ev.repeat 있는 원본)에 적용됨 —
// 특정 발생일 하나만 따로 저장하는 기능은 없음(단순화). 날짜를 바꾸면 반복 시작일이 바뀜.
function saveEditPersonal(id, fields) {
  const idx = localData.personalEvents.findIndex(e => e.id === id);
  if (idx >= 0) {
    const ev = localData.personalEvents[idx];
    const dateField = ev.repeat ? { startDate: fields.date } : { date: fields.date };
    localData.personalEvents[idx] = {
      ...ev, title: fields.title, ...dateField,
      time: fields.time, allDay: !fields.time,
      category: fields.category, author: fields.author,
      colorId: state.categories[fields.category] || '8'
    };
    persistLocalData();
  }
  closeAddModal();
  renderGrid();
  renderDayPanel();
  resettleSize();
}

// ===== Recurring event management =====
const WEEKDAY_ABBR_EN = { SU:'Sun', MO:'Mon', TU:'Tue', WE:'Wed', TH:'Thu', FR:'Fri', SA:'Sat' };

function describeRRule(rrule) {
  if (!rrule) return '';
  const parts = {};
  rrule.replace('RRULE:', '').split(';').forEach(p => {
    const [k, v] = p.split('=');
    parts[k] = v;
  });
  const interval = parseInt(parts.INTERVAL || '1', 10);
  let label;
  if (parts.FREQ === 'DAILY') label = `Every ${interval} day${interval > 1 ? 's' : ''}`;
  else if (parts.FREQ === 'WEEKLY') label = interval >= 2 ? 'Biweekly' : 'Weekly';
  else label = parts.FREQ || '';

  if (parts.BYDAY) {
    const days = parts.BYDAY.split(',').map(d => WEEKDAY_ABBR_EN[d] || d).join(',');
    label += ` on ${days}`;
  }
  if (parts.UNTIL) {
    const y = parts.UNTIL.slice(0, 4), m = parts.UNTIL.slice(4, 6), d = parts.UNTIL.slice(6, 8);
    label += ` (until ${y}-${m}-${d})`;
  }
  return label;
}

async function openRecurringModal() {
  $('#recurringBackdrop').classList.add('open');
  const list = $('#recurringList');
  list.innerHTML = '<li class="empty-hint">Loading...</li>';
  resizeToContent();

  const res = await apiGet({ action: 'list-recurring' });
  if (!res.ok) { list.innerHTML = '<li class="empty-hint">Failed to load</li>'; resizeToContent(); return; }
  renderRecurringList(res.series);
  resizeToContent();
}

function renderRecurringList(series) {
  const list = $('#recurringList');
  list.innerHTML = '';
  if (!series.length) {
    list.innerHTML = '<li class="empty-hint">No recurring events</li>';
    return;
  }
  series.forEach(s => {
    const li = document.createElement('li');
    li.className = 'event-row';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dotStyle(dot, s);
    li.appendChild(dot);

    const body = document.createElement('div');
    body.className = 'event-body';
    const title = document.createElement('span');
    title.className = 'event-title';
    title.textContent = s.title;
    body.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'event-meta';
    meta.textContent = [describeRRule(s.rrule), s.category, s.author].filter(Boolean).join(' · ');
    body.appendChild(meta);
    li.appendChild(body);

    const del = document.createElement('button');
    del.className = 'event-del';
    del.textContent = '×';
    del.addEventListener('click', async () => {
      if (!safeConfirm(`"${s.title}" 반복 일정 전체를 삭제할까요?`)) return;

      // 낙관적 삭제 — 목록에서 바로 제거, 실패하면 되돌림
      const remaining = series.filter(x => x.id !== s.id);
      renderRecurringList(remaining);

      let r;
      try {
        r = await apiPost({ action: 'delete', eventId: s.id, deleteSeries: true });
      } catch (err) {
        r = { ok: false, error: err.message || '네트워크 오류' };
      }

      if (!r.ok) {
        safeAlert('삭제 실패: ' + r.error);
        renderRecurringList(series); // 롤백
        return;
      }
      loadMonth(); // 메인 그리드에서도 점 갱신
    });
    li.appendChild(del);

    list.appendChild(li);
  });
}

// ===== 이벤트 바인딩 =====
function bindEvents() {
  $('#prevMonth').addEventListener('click', () => {
    state.month--; if (state.month < 1) { state.month = 12; state.year--; }
    loadMonth();
  });
  $('#nextMonth').addEventListener('click', () => {
    state.month++; if (state.month > 12) { state.month = 1; state.year++; }
    loadMonth();
  });
  $('#todayBtn').addEventListener('click', () => {
    const now = new Date();
    state.year = now.getFullYear(); state.month = now.getMonth() + 1;
    state.selectedDate = todayKey();
    loadMonth();
  });

  $('#openAdd').addEventListener('click', openAddModal);
  $('#closeModal').addEventListener('click', closeAddModal);
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeAddModal(); });
  $('#saveEvent').addEventListener('click', onSaveEvent);

  // 업무명만 입력하고 엔터 → 나머지 기본값 그대로 바로 저장 (아무 설정도 안 건드리는 사용자용)
  $('#fTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onSaveEvent(); }
  });

  // 개인 할일(로컬 전용) — 입력 후 엔터로 추가
  $('#todoInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addPersonalTodo($('#todoInput').value);
      $('#todoInput').value = '';
    }
  });

  $('#fRepeat').addEventListener('change', (e) => {
    const v = e.target.value;
    $('#biweeklyRow').hidden = !(v === 'weekly' || v === 'biweekly');
    $('#customRow').hidden = v !== 'custom';
    $('#untilRow').hidden = v === 'none';
    if (v === 'weekly' || v === 'biweekly') preselectWeekdayIfEmpty();
    resizeToContent();
  });

  $('#fDate').addEventListener('change', () => {
    // 날짜를 바꾸면, 아직 요일을 고르지 않았을 때만 기본 체크를 그 날짜 기준으로 다시 맞춤
    const v = $('#fRepeat').value;
    if (v === 'weekly' || v === 'biweekly') preselectWeekdayIfEmpty();
  });

  $('#weekdayPicker').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-day]');
    if (btn) btn.classList.toggle('active');
  });

  // ── Personal / Team Post 토글 ── (수정 중엔 locked라 클릭해도 안 바뀜)
  $('#scopeToggle').addEventListener('click', (e) => {
    if ($('#scopeToggle').classList.contains('locked')) return;
    const btn = e.target.closest('.scope-btn');
    if (!btn) return;
    setScopeToggle(btn.dataset.scope, false);
    resizeToContent();
  });

  // ── 수동 새로고침 ──
  $('#refreshBtn').addEventListener('click', () => {
    const icon = $('#refreshBtn');
    icon.classList.add('spinning');
    monthCache.delete(monthKey(state.year, state.month)); // 캐시 무시하고 강제로 다시 받아옴
    apiGet({ action: 'categories' }).then(catRes => { if (catRes.ok) state.categories = catRes.categories; });
    loadMonth().finally(() => icon.classList.remove('spinning'));
  });

  // ── 설정 팝업 ──
  $('#gearBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#settingsPopover').classList.toggle('open');
    $('#popoverBackdrop').classList.toggle('open');
    resizeToContent();
  });
  $('#popoverBackdrop').addEventListener('click', closePopover);

  $('#settingsPopover').addEventListener('click', (e) => {
    // .popover-item로 범위를 좁혀야 함 — 다크/Tack 테마에서는 <html data-theme="dark">가 붙어서
    // 그냥 '[data-theme]'로 찾으면 <html> 자신이 조상으로 매치되어 뷰모드 클릭까지 테마 분기로 새버렸음
    const themeBtn = e.target.closest('.popover-item[data-theme]');
    if (themeBtn) {
      applyTheme(themeBtn.dataset.theme);
      localStorage.setItem('tkm_theme', themeBtn.dataset.theme);
      closePopover();
      return;
    }
    const viewBtn = e.target.closest('.popover-item[data-view]');
    if (viewBtn) {
      applyViewMode(viewBtn.dataset.view);
      localStorage.setItem('tkm_viewmode', viewBtn.dataset.view);
      closePopover();
      return;
    }
  });

  $('#openRecurringMgmt').addEventListener('click', () => {
    closePopover();
    openRecurringModal();
  });

  // ── 윈도우 시작 시 자동 실행 (Electron 전용 — 웹 버전은 window.api가 없어서 자동 무시됨) ──
  $('#autoLaunchBtn')?.addEventListener('click', async () => {
    const next = await window.api?.toggleAutoLaunch?.();
    $('#autoLaunchBtn').classList.toggle('active', !!next);
    resizeToContent();
  });

  // ── 수동 업데이트 확인 ──
  $('#checkUpdateBtn')?.addEventListener('click', () => {
    $('#updateStatus').textContent = 'Checking for updates...';
    resizeToContent();
    window.api?.checkForUpdates?.();
  });
  window.api?.onUpdateStatus?.((data) => {
    const messages = {
      checking: 'Checking for updates...',
      available: `Update found (v${data.extra})`,
      downloading: `Downloading update... ${data.extra}%`,
      'not-available': 'You have the latest version.',
      downloaded: `Update ready (v${data.extra}) — restart to install.`,
      error: data.extra ? `Update check failed: ${data.extra}` : 'Update check failed.'
    };
    const el = $('#updateStatus');
    if (el) el.textContent = messages[data.status] || '';
    resizeToContent();
  });
  $('#closeRecurring').addEventListener('click', () => { $('#recurringBackdrop').classList.remove('open'); resizeToContent(); });
  $('#recurringBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'recurringBackdrop') { $('#recurringBackdrop').classList.remove('open'); resizeToContent(); }
  });

  $('#dayPanelToggle').addEventListener('click', () => {
    state.dayPanelCollapsed = !state.dayPanelCollapsed;
    updateDayPanelVisibility();
    resizeToContent();
  });

  // ── 창 컨트롤 (Electron 연결 전까지는 window.api가 없어 조용히 무시됨) ──
  // 핀 고정 상태일 때는 비어있는(무채색) 아이콘, 고정 안 됐을 때만 강조색 — Tack과 동일한 관례
  $('#pinBtn').addEventListener('click', async () => {
    const pinned = await window.api?.togglePin?.();
    if (pinned !== undefined) $('#pinBtn').classList.toggle('active', !pinned);
  });
  $('#minimizeBtn').addEventListener('click', () => window.api?.winMinimize?.());
  $('#closeBtn').addEventListener('click', () => window.api?.winClose?.());
  window.api?.getPin?.().then(p => { if (p !== undefined) $('#pinBtn').classList.toggle('active', !p); });
}

init();
