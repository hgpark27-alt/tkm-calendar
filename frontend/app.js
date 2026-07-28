// ===== 로컬 전용 데이터 (구글 캘린더로 절대 안 올라감 — 이 컴퓨터에만 저장) =====
// Electron이면 main 프로세스가 파일로 원자적 저장(Tack 방식), 브라우저 테스트 중이면 localStorage로 대체
let localData = { recentTasks: [], personalTodos: [], personalEvents: [], icsUrl: '', calendarActivity: [], userName: '', tasksMigrated: false, seenTaskIds: [] };

async function loadLocalData() {
  if (window.api?.getLocalData) {
    localData = await window.api.getLocalData();
  } else {
    try { localData = JSON.parse(localStorage.getItem('tkm_localdata') || '{}'); } catch { localData = {}; }
  }
  localData.recentTasks ??= [];
  localData.personalTodos ??= []; // 웹 이관 전 예전 My Notes 백업(이관 끝나면 비워짐) — migrateLocalTasksIfNeeded 참고
  localData.personalEvents ??= []; // "Personal" 일정 — 구글 캘린더로 절대 안 올라가고 이 컴퓨터에만 저장
  localData.icsUrl ??= '';
  localData.calendarActivity ??= []; // 팀 일정 추가/수정/삭제 알림 로그 (최대 20개)
  localData.userName ??= ''; // My Notes(공유 태스크) 작성자 표시용 — 최초 1회만 물어봄(ensureUserName)
  localData.tasksMigrated ??= false;
  localData.seenTaskIds ??= []; // 이미 "받았다" 토스트를 보여준 태스크 id — 재알림 방지용(이 컴퓨터에만 저장)
}

// ===== 개인 ICS 캘린더 구독 (설정에서 각자 등록 — 이 컴퓨터에만 저장, 팀과 무관) =====
let icsEvents = {}; // 'YYYY-MM-DD' -> [{title, time, allDay}]

function icsEventsForMonth(y, m) {
  const prefix = `${y}-${pad2(m)}`;
  const results = [];
  Object.keys(icsEvents).forEach(date => {
    if (!date.startsWith(prefix)) return;
    icsEvents[date].forEach(ev => results.push({ ...ev, date, category: '', isPersonal: true, isIcs: true }));
  });
  return results;
}

async function syncPersonalIcs() {
  const url = (localData.icsUrl || '').trim();
  if (!url) { icsEvents = {}; renderGrid(); renderDayPanel(); return { ok: false, error: '주소 없음' }; }
  if (!window.api?.fetchIcs) return { ok: false, error: 'Electron 환경에서만 지원' };
  const res = await window.api.fetchIcs(url);
  if (!res.ok) return { ok: false, error: res.error };
  icsEvents = parseIcsToEventsByDate(res.text);
  renderGrid();
  renderDayPanel();
  let count = 0;
  Object.values(icsEvents).forEach(arr => { count += arr.length; });
  return { ok: true, count };
}

// 일반적인 외부 ICS(구글/아웃룩/아이클라우드 등)를 최대한 관대하게 파싱.
// RRULE 반복 규칙 자체의 확장은 지원하지 않음 — 대부분의 구독용 ICS는 가까운 기간의
// 반복 일정을 이미 개별 발생건으로 펼쳐서 내려주기 때문에 실사용에는 크게 문제 없음(알려진 한계).
function parseIcsToEventsByDate(icsText) {
  const rawLines = icsText.split(/\r\n|\n|\r/);
  const lines = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += line.slice(1); // 줄 접힘(folding) 풀기
    } else {
      lines.push(line);
    }
  }

  const byDate = {};
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.date) {
        (byDate[cur.date] ??= []).push({ title: cur.title || '(제목 없음)', time: cur.time || null, allDay: !cur.time });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('DTSTART')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const head = line.slice(0, idx), value = line.slice(idx + 1).trim();
      if (head.includes('VALUE=DATE') && !head.includes('DATE-TIME')) {
        cur.date = value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8);
      } else {
        const digits = value.replace('Z', '');
        cur.date = digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6, 8);
        if (digits.length >= 13) cur.time = digits.slice(9, 11) + ':' + digits.slice(11, 13);
      }
    } else if (line.startsWith('SUMMARY')) {
      const idx = line.indexOf(':');
      cur.title = idx >= 0 ? line.slice(idx + 1).trim() : '';
    }
  }
  return byDate;
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

// My Notes는 이제 이 컴퓨터에만 있는 게 아니라 구글 시트를 통해 팀 전체가 공유하는 태스크임 —
// sharedTasks에 서버가 준 평평한(flat) 목록을 그대로 두고, 화면에 그릴 때만 parentId 기준으로
// 부모-자식(1단계까지만) 트리 모양으로 다시 묶음. 태스크는 "보낸 대상"(assignee)이 있어서 —
// 비어있으면 전체 공개, 채워져 있으면 그 사람 또는 만든 사람(owner) 눈에만 보임(visibleTaskTree).
let sharedTasks = [];
let members = [];
let shareModalTaskId = null; // 지금 공유 대상 모달이 열려있는 태스크 id

// assignee가 비어있으면(기본값) "전체 공개"로 취급했던 게 버그였음 — 그래서 아무 설정도 안 하고
// 그냥 노트만 적으면 팀원 전체한테 다 보여버렸고(각자 개인 메모였던 것들이 전부 공개됨),
// 예전 로컬 전용 My Notes를 이관할 때도 같은 이유로 전체공개가 돼버려서 사고가 남(다른 사람
// 화면에 내 개인 메모가 잔뜩 섞여 보이는 문제 — 실제 데이터가 지워진 건 아니고 순전히 노출 범위
// 버그). 이제 비어있으면 "나만 보임"(owner 조건으로 이미 커버됨)이 기본이고, "전체 공개"는
// SHARE_ALL이라는 별도 값을 명시적으로 골라야만(공유 모달의 "전체") 켜지게 바꿈.
const SHARE_ALL = '__ALL__';
function visibleTaskTree() {
  const mine = sharedTasks.filter(t => t.assignee === SHARE_ALL || t.assignee === localData.userName || t.owner === localData.userName);
  const byId = new Map();
  mine.forEach(t => { t.children = []; byId.set(t.id, t); });
  const roots = [];
  byId.forEach(t => {
    if (t.parentId && byId.has(t.parentId)) byId.get(t.parentId).children.push(t);
    else roots.push(t);
  });
  const byOrder = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0);
  roots.sort(byOrder);
  roots.forEach(r => r.children.sort(byOrder));
  return roots;
}

function renderPersonalTodos() {
  const list = $('#todoList');
  list.innerHTML = '';
  visibleTaskTree().forEach(todo => {
    list.appendChild(buildTodoRow(todo, null));
    (todo.children || []).forEach(child => {
      list.appendChild(buildTodoRow(child, todo.id));
    });
  });
  resizeToContent();
}

// 오프라인이거나 서버가 잠깐 안 되면 fetch 자체가 예외를 던질 수 있음 — 그냥 두면(await 안 하고
// 호출하는 init()/폴링 쪽에서) 처리 안 된 프라미스 거부로 콘솔에 계속 경고가 남으니 여기서 삼킴.
// 실패해도 sharedTasks/members는 이전 값 그대로 유지되고, 다음 폴링 때 다시 시도됨
async function fetchSharedTasks() {
  try {
    const res = await apiGet({ action: 'tasksList' });
    if (res.ok) {
      sharedTasks = res.tasks;
      notifyNewlyReceivedTasks(); // 새로 나("assignee")한테 보내진 태스크가 있으면 토스트로 알림
      renderPersonalTodos();
    }
  } catch (err) { console.error('[fetchSharedTasks] 실패(오프라인 등)', err); }
}
async function fetchMembers() {
  try {
    const res = await apiGet({ action: 'membersList' });
    if (res.ok) { members = res.members; }
  } catch (err) { console.error('[fetchMembers] 실패(오프라인 등)', err); }
}

// 남이 만들어서(owner !== 나) 나한테 특정해서 보낸(assignee === 나) 태스크 중, 아직 토스트로
// 안 보여준 것만 알림 — seenTaskIds(로컬 저장)에 한 번 넣으면 다음 폴링부턴 다시 안 뜸
function notifyNewlyReceivedTasks() {
  const fresh = sharedTasks.filter(t =>
    t.assignee === localData.userName &&
    t.owner !== localData.userName &&
    !localData.seenTaskIds.includes(t.id)
  );
  if (!fresh.length) return;
  fresh.forEach(t => {
    localData.seenTaskIds.push(t.id);
    showTaskToast(t);
  });
  persistLocalData();
}

function showTaskToast(task) {
  const stack = $('#toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast';
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = `${task.owner}님으로부터 태스크를 받았습니다: "${task.text}" 추가하시겠습니까?`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.textContent = '확인';
  close.addEventListener('click', () => el.remove());
  el.appendChild(text);
  el.appendChild(close);
  stack.appendChild(el);
  setTimeout(() => el.remove(), 8000); // 안 눌러도 8초 뒤 자동으로 사라짐
}

// ===== 태스크 공유 대상 선택 모달 =====
// 목록에서 이름을 눌러도 그 자리에서 바로 공유되지 않고 "선택"만 됨(하이라이트) — 실제 반영은
// 아래 "공유하기" 버튼을 눌러야 함. 모달을 열 때도 아무것도 미리 선택해두지 않음(전체가 기본
// 선택된 상태였으면 실수로 버튼을 눌렀을 때 전체공유가 돼버리는 사고가 날 수 있어서 방지)
let pendingShareTarget = null;
function openShareModal(taskId) {
  shareModalTaskId = taskId;
  pendingShareTarget = null;
  renderShareList();
  $('#confirmShareBtn').disabled = true;
  $('#shareBackdrop').classList.add('open');
  resizeToContent();
}
function closeShareModal() {
  shareModalTaskId = null;
  pendingShareTarget = null;
  $('#shareBackdrop').classList.remove('open');
  resizeToContent();
}
function renderShareList() {
  const list = $('#shareList');
  list.innerHTML = '';
  const { todo } = findTodoAndParent(shareModalTaskId);
  const currentAssignee = todo ? (todo.assignee || '') : '';
  $('#shareCurrentHint').textContent =
    currentAssignee === SHARE_ALL ? '현재 전체 공개'
    : currentAssignee ? `현재 "${currentAssignee}"님에게 공유됨`
    : '현재 나만 보임(비공개)';

  const makeItem = (value, label, isAll) => {
    const li = document.createElement('li');
    li.className = 'share-item' + (isAll ? ' share-all' : '') + (value === pendingShareTarget ? ' selected' : '');
    const span = document.createElement('span');
    span.textContent = label;
    li.appendChild(span);
    if (value === pendingShareTarget) {
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = '✓';
      li.appendChild(check);
    }
    li.addEventListener('click', () => {
      pendingShareTarget = value;
      renderShareList();
      $('#confirmShareBtn').disabled = false;
    });
    return li;
  };

  list.appendChild(makeItem('', '나만 보기(비공개)', true));
  list.appendChild(makeItem(SHARE_ALL, '전체', true));
  members.filter(name => name !== localData.userName).forEach(name => {
    list.appendChild(makeItem(name, name, false));
  });
}
function confirmShareTarget() {
  if (pendingShareTarget === null) return; // 아직 아무것도 선택 안 했으면 눌러도 아무 일 없음
  const taskId = shareModalTaskId;
  const assignee = pendingShareTarget;
  const { todo } = findTodoAndParent(taskId);
  if (!todo) { closeShareModal(); return; }
  todo.assignee = assignee; // 낙관적 반영
  renderPersonalTodos();
  closeShareModal();
  apiPost({ action: 'taskAssign', id: taskId, assignee });
}

// ===== 회원 관리(관리자 전용 — "지금 로그인한 이름이 ADMIN_NAME인가"만 보고 간단히 판단) =====
const ADMIN_NAME = '박혜근';
async function openMembersModal() {
  $('#membersBackdrop').classList.add('open');
  resizeToContent();
  renderMemberMgmtList(); // 캐시된 목록 먼저 보여주고
  await fetchMembers();
  renderMemberMgmtList(); // 최신 목록으로 다시 그림
}
function closeMembersModal() {
  $('#membersBackdrop').classList.remove('open');
  resizeToContent();
}
function renderMemberMgmtList() {
  const list = $('#memberMgmtList');
  list.innerHTML = '';
  members.forEach(name => {
    const li = document.createElement('li');
    li.className = 'member-mgmt-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'member-mgmt-name';
    nameSpan.textContent = name;
    li.appendChild(nameSpan);

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'member-mgmt-rename';
    renameBtn.textContent = '이름 변경';
    renameBtn.addEventListener('click', () => startRenameMember(name, li, nameSpan));
    li.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'member-mgmt-del';
    delBtn.textContent = '삭제';
    delBtn.addEventListener('click', () => deleteMember(name));
    li.appendChild(delBtn);

    list.appendChild(li);
  });
}
function startRenameMember(oldName, li, nameSpan) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'member-mgmt-edit-input';
  input.value = oldName;
  li.replaceChild(input, nameSpan);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (!newName || newName === oldName) { renderMemberMgmtList(); return; }
    // 낙관적 반영 — 명단/공유 태스크의 owner·assignee 표시, 내 이름(나 자신을 바꾼 경우)까지 바로 갱신
    members = members.map(n => (n === oldName ? newName : n));
    sharedTasks.forEach(t => {
      if (t.owner === oldName) t.owner = newName;
      if (t.assignee === oldName) t.assignee = newName;
    });
    if (localData.userName === oldName) { localData.userName = newName; persistLocalData(); }
    renderMemberMgmtList();
    renderPersonalTodos();
    try {
      await apiPost({ action: 'memberRename', oldName, newName });
    } catch (err) {
      console.error('[renameMember] 실패(오프라인 등) — 다음에 다시 시도 필요', err);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { done = true; renderMemberMgmtList(); }
  });
  input.addEventListener('blur', commit);
}
function deleteMember(name) {
  members = members.filter(n => n !== name); // 낙관적 반영 — 남긴 태스크 자체는 그대로 둠
  renderMemberMgmtList();
  apiPost({ action: 'memberDelete', name });
}

function findTodoAndParent(id) {
  const todo = sharedTasks.find(t => t.id === id);
  if (!todo) return { todo: null, parent: null };
  const parent = todo.parentId ? sharedTasks.find(t => t.id === todo.parentId) : null;
  return { todo, parent };
}
function findParentIdOfChild(childId) {
  const todo = sharedTasks.find(t => t.id === childId);
  return todo ? (todo.parentId || null) : null;
}

// ===== My Notes 드래그로 순서 바꾸기 =====
// 같은 급(최상위끼리, 또는 같은 부모의 자식끼리)에서만 순서가 바뀜 — 부모/자식 관계 자체는
// 드래그로 안 바뀜(1단계 트리 구조 유지). 핸들은 텍스트(.todo-text) 부분만 — 체크박스/×/+
// 버튼은 그대로 각자의 클릭 동작만 하게 둠. 접힘 모드에서도 드래그로 순서를 바꿀 수 있어야
// 하는데, 드래그가 끝난 뒤 이어지는 click 이벤트가 "펼치기"나 "편집 시작"을 트리거하면 안 되므로
// suppressNoteClick 플래그로 그 다음 click 한 번만 무시함(위쪽 window-move 드래그의 dragMoved와 같은 패턴)
let draggingNoteId = null;
let suppressNoteClick = false;
// sharedTasks가 이제 평평한 목록이라(부모 객체 안에 children 배열이 없음) 같은 그룹(parentId가
// 같은 것들)만 뽑아서 순서를 다시 매김 — 그 결과를 sharedTasks 안의 실제 객체에 바로 반영(즉시
// 화면 반영용). 서버 저장은 드래그 끝날 때(mouseup) 한 번에 함
function reorderNote(parentId, draggedId, targetId) {
  const groupIds = sharedTasks
    .filter(t => (t.parentId || null) === (parentId || null))
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    .map(t => t.id);
  const fromIdx = groupIds.indexOf(draggedId);
  const toIdx = groupIds.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
  const [id] = groupIds.splice(fromIdx, 1);
  groupIds.splice(toIdx, 0, id);
  groupIds.forEach((tid, i) => {
    const t = sharedTasks.find(x => x.id === tid);
    if (t) t.order = i;
  });
}
function startNoteDrag(e, todo, parentId) {
  if (e.button !== 0) return;
  const startX = e.clientX, startY = e.clientY;
  let dragging = false;
  let lastOverId = null;
  const onMove = (ev) => {
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
      dragging = true;
      draggingNoteId = todo.id;
      $('#todoList').classList.add('reordering');
      renderPersonalTodos();
    }
    if (!dragging) return;
    const overEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.todo-item');
    if (!overEl) return;
    const overId = overEl.dataset.id;
    if (overId === todo.id || overId === lastOverId) return;
    const overIsChild = overEl.classList.contains('todo-child');
    if (parentId) {
      if (!overIsChild || findParentIdOfChild(overId) !== parentId) return; // 자식은 같은 부모의 자식끼리만
    } else if (overIsChild) {
      return; // 최상위는 최상위끼리만
    }
    lastOverId = overId;
    reorderNote(parentId, todo.id, overId);
    renderPersonalTodos();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (dragging) {
      draggingNoteId = null;
      $('#todoList').classList.remove('reordering');
      renderPersonalTodos();
      // 바뀐 그룹 전체의 새 순서를 서버에 반영 — 실패해도 다음 폴링 때 서버 값으로 다시 맞춰짐
      sharedTasks
        .filter(t => (t.parentId || null) === (parentId || null))
        .forEach(t => apiPost({ action: 'taskReorder', id: t.id, order: t.order }));
      suppressNoteClick = true;
      setTimeout(() => { suppressNoteClick = false; }, 50);
    }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function buildTodoRow(todo, parentId) {
  const isChild = !!parentId;
  const li = document.createElement('li');
  li.className = 'todo-item' + (isChild ? ' todo-child' : '') + (todo.id === draggingNoteId ? ' todo-dragging' : '');
  li.dataset.id = todo.id;

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'todo-check' + (todo.done ? ' done' : '');
  check.textContent = todo.done ? '✓' : '';
  check.addEventListener('click', () => toggleTodo(todo.id));
  li.appendChild(check);

  const text = document.createElement('span');
  text.className = 'todo-text' + (todo.done ? ' done' : '');
  text.textContent = todo.text;
  text.title = '드래그해서 순서 변경, 클릭해서 수정';
  text.addEventListener('mousedown', (e) => startNoteDrag(e, todo, parentId));
  text.addEventListener('click', () => { if (!suppressNoteClick) startEditTodo(todo.id); });
  li.appendChild(text);

  // 내가 만든 게 아닌(공유받았거나 전체공개로 보이는) 노트는 누가 쓴 건지 표시 — 안 그러면
  // 여러 사람 노트가 한 목록에 섞여 보일 때 누구 건지 구분이 안 돼서 "내용이 뒤섞였다"고
  // 오해하기 쉬움(실제로는 각자 자기 이름으로 서버에 잘 저장돼 있는데 화면에 구분 표시가 없었음)
  if (todo.owner && todo.owner !== localData.userName) {
    const ownerTag = document.createElement('span');
    ownerTag.className = 'todo-owner-tag';
    ownerTag.textContent = todo.owner;
    li.appendChild(ownerTag);
  }

  if (!isChild) {
    const addChild = document.createElement('button');
    addChild.type = 'button';
    addChild.className = 'todo-add-child';
    addChild.title = '하위 항목 추가';
    addChild.textContent = '+';
    addChild.addEventListener('click', () => addChildTodo(todo.id));
    li.appendChild(addChild);
  }

  const isOwner = !todo.owner || todo.owner === localData.userName; // 예전 마이그레이션 등으로 owner가 비어있으면 그냥 내 것 취급
  // 공유 대상을 정하는 건 원래 만든 사람만 — 안 그러면 받은 사람이 남의 노트를 마음대로
  // 다른 사람한테 재전송하는 것도 가능해져버림
  if (isOwner) {
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'todo-share' + (todo.assignee ? ' active' : '');
    share.title = todo.assignee === SHARE_ALL ? '전체에게 공유됨' : todo.assignee ? `${todo.assignee}님에게 공유됨` : '공유하기(나만 보임)';
    share.textContent = '↗';
    share.addEventListener('click', () => openShareModal(todo.id));
    li.appendChild(share);
  }

  // 시트에는 노트당 딱 한 줄만 있음(복사본이 아니라 참조 공유) — 그래서 삭제 버튼 동작이
  // 누가 눌렀느냐에 따라 달라야 함:
  //  - 만든 사람이 지우면: 진짜 삭제(원본 자체를 지움, 다른 사람 화면에서도 사라짐 — 의도된 동작)
  //  - "나한테만" 공유받은 사람이 지우면: 원본은 안 건드리고 공유만 취소(assignee를 비워서
  //    내 화면에서만 사라지게 함, owner는 계속 봄) — "받은사람이 지우면 그사람 것만 사라진다"는
  //    요구사항을 원본 하나로도 만족시키는 가장 단순한 방법
  //  - "전체공개"로 보이는 걸 owner가 아닌 사람이 보는 경우: 나만 숨기는 기능이 아직 없어서
  //    (그러려면 사람마다 "숨김 목록"을 따로 저장해야 함) 실수로 원본이 삭제되는 걸 막는 게
  //    우선이라, 이 경우는 삭제 버튼 자체를 안 보여줌
  if (isOwner || todo.assignee === localData.userName) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'todo-del';
    del.title = isOwner ? '삭제' : '공유 취소(내 화면에서만 안 보이게)';
    del.textContent = '×';
    del.addEventListener('click', () => deleteTodo(todo.id));
    li.appendChild(del);
  }

  return li;
}

// 텍스트를 눌렀을 때 그 자리에서 바로 고칠 수 있게 입력창으로 바꿔치기
function startEditTodo(id) {
  const row = $(`#todoList li[data-id="${id}"]`);
  const { todo } = findTodoAndParent(id);
  if (!row || !todo) return;
  const textEl = row.querySelector('.todo-text');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'todo-edit-input';
  input.value = todo.text;
  row.replaceChild(input, textEl);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (!v) { deleteTodo(todo.id); return; } // 비워두고 저장하면 그냥 삭제 취급
    todo.text = v; // 낙관적 반영 — 서버 응답 기다리지 않고 바로 화면에 보여줌
    renderPersonalTodos();
    // id가 아닌 todo.id를 씀 — 방금 낙관적으로 추가된 항목이라면 타이핑하는 사이 임시 id가
    // 서버의 진짜 id로 바꿔치기됐을 수 있어서, 항상 "지금" 값을 읽어야 함
    await apiPost({ action: 'taskUpdate', id: todo.id, text: v });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { done = true; renderPersonalTodos(); }
  });
  input.addEventListener('blur', commit);
}

// Apps Script 왕복(느리면 1~2초)을 기다렸다가 화면에 보여주면 입력할 때마다 눈에 띄게
// 버벅여 보임 — 그래서 taskAdd도 다른 동작들처럼 낙관적으로 처리함: 임시 id로 즉시 화면에
// 보여준 뒤, 서버 응답이 오면 그 임시 id를 서버가 준 진짜 id로 조용히 바꿔치기(리렌더 없이
// dataset.id만 갱신 — 리렌더를 하면 addChildTodo가 바로 이어서 여는 편집 입력창이 도중에
// 날아가버림). 실패하면 임시로 보여줬던 항목을 다시 지움.
function makeTempTaskId() {
  return 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}
function patchTaskId(task, realId) {
  const tempId = task.id;
  task.id = realId;
  const row = $(`#todoList li[data-id="${tempId}"]`);
  if (row) row.dataset.id = realId;
  // 이 임시 id를 parentId로 물고 있던 자식(방금 부모가 생기자마자 바로 하위 항목을 추가한 경우)도 같이 맞춤
  sharedTasks.forEach(c => { if (c.parentId === tempId) c.parentId = realId; });
}
function rollbackTempTask(tempId) {
  sharedTasks = sharedTasks.filter(x => x.id !== tempId && x.parentId !== tempId);
  renderPersonalTodos();
}

// 새 최상위 노트를 추가할 때 정렬 순서를 기존 것보다 앞(더 작은 order)에 둬서 위로 올라오게 함
// (예전 로컬 배열의 unshift와 같은 효과)
function addPersonalTodo(text) {
  const t = (text || '').trim();
  if (!t) return;
  const topLevel = sharedTasks.filter(x => !x.parentId);
  const newOrder = topLevel.length ? Math.min(...topLevel.map(x => Number(x.order) || 0)) - 1 : 0;
  const owner = localData.userName, assignee = ''; // 새로 만들 땐 항상 전체 공개 — 공유 대상은 만든 뒤 ↗ 버튼으로 지정
  const task = { id: makeTempTaskId(), text: t, done: false, parentId: '', order: newOrder, owner, assignee, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  sharedTasks.push(task);
  renderPersonalTodos();
  const tempId = task.id;
  apiPost({ action: 'taskAdd', text: t, owner, assignee, parentId: '', order: newOrder })
    .then(res => { if (res.ok) patchTaskId(task, res.id); else rollbackTempTask(tempId); })
    .catch(err => { console.error('[addPersonalTodo] 저장 실패(오프라인 등)', err); rollbackTempTask(tempId); });
}
function addChildTodo(parentId) {
  const parent = sharedTasks.find(t => t.id === parentId);
  if (!parent) return;
  const siblings = sharedTasks.filter(t => t.parentId === parentId);
  const newOrder = siblings.length ? Math.max(...siblings.map(t => Number(t.order) || 0)) + 1 : 0;
  const owner = localData.userName, assignee = parent.assignee || ''; // 하위 항목은 상위 항목의 "보낸 대상"을 그대로 물려받음
  const task = { id: makeTempTaskId(), text: '', done: false, parentId, order: newOrder, owner, assignee, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  sharedTasks.push(task);
  renderPersonalTodos();
  startEditTodo(task.id); // 추가하자마자 바로 입력할 수 있게(응답 기다리지 않음)
  const tempId = task.id;
  apiPost({ action: 'taskAdd', text: '', owner, assignee, parentId, order: newOrder })
    .then(res => { if (res.ok) patchTaskId(task, res.id); else rollbackTempTask(tempId); })
    .catch(err => { console.error('[addChildTodo] 저장 실패(오프라인 등)', err); rollbackTempTask(tempId); });
}
function toggleTodo(id) {
  const { todo } = findTodoAndParent(id);
  if (!todo) return;
  todo.done = !todo.done; // 낙관적 반영
  renderPersonalTodos();
  apiPost({ action: 'taskToggle', id });
}
function deleteTodo(id) {
  const { todo } = findTodoAndParent(id);
  const isOwner = !todo || !todo.owner || todo.owner === localData.userName;
  sharedTasks = sharedTasks.filter(t => t.id !== id && t.parentId !== id); // 내 화면에서는 부모면 자식(1단계)도 같이 정리
  renderPersonalTodos();
  if (isOwner) {
    apiPost({ action: 'taskDelete', id }); // 원본 삭제 — 다른 사람 화면에서도 사라짐
  } else {
    // 내가 만든 게 아님 — 원본은 그대로 두고 "나에게 공유된 것"만 취소함(assignee를 비움).
    // owner는 그대로 자기 노트로 계속 봄, 나만 내 목록에서 사라짐(복사본이 아니라 참조 공유라
    // 원본을 건드리지 않고 "내 화면에서만 안 보이게" 하려면 이 방법뿐)
    apiPost({ action: 'taskAssign', id, assignee: '' });
  }
}

// 최초 실행 시 이름 하나만 물어봄(비밀번호 없음, 취소 불가) — 이후엔 이 컴퓨터에 저장된 이름을
// 계속 씀. 팀원 명단(Members)에도 등록해서 "태스크 보내기" 드롭다운에 뜨게 함. 톱니 메뉴의
// "내 이름 바꾸기"는 같은 모달을 취소 가능하게(닫기 버튼 보이게) 다시 열어서 재사용함(editUserName)
function openNamePrompt(cancelable) {
  return new Promise((resolve) => {
    $('#nameBackdrop').classList.add('open');
    $('#closeNameModal').hidden = !cancelable;
    resizeToContent();
    const input = $('#fUserName');
    input.value = localData.userName || '';
    const btn = $('#saveUserName');
    const closeBtn = $('#closeNameModal');
    let done = false;
    const cleanup = () => {
      done = true;
      btn.removeEventListener('click', submit);
      input.removeEventListener('keydown', onKey);
      closeBtn.removeEventListener('click', onCancel);
      $('#nameBackdrop').classList.remove('open');
      resizeToContent();
    };
    const onKey = (e) => { if (e.key === 'Enter') submit(); };
    const onCancel = () => { if (done) return; cleanup(); resolve(); };
    const submit = async () => {
      if (done) return;
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      const changed = v !== localData.userName;
      cleanup();
      localData.userName = v;
      persistLocalData();
      if ($('#manageMembersBtn')) $('#manageMembersBtn').hidden = v !== ADMIN_NAME;
      // 네트워크가 끊겨있으면 memberRegister가 예외를 던질 수 있는데, 그걸 그냥 두면 resolve()가
      // 영원히 안 불려서 앱 시작 자체가 멈춰버림 — 오프라인이어도 이름은 이미 저장했으니 일단
      // 진행시키고, 명단 등록/새로고침은 되면 하고 안 되면 다음 폴링 때 다시 시도되게 둠
      if (changed) {
        try {
          await apiPost({ action: 'memberRegister', name: v });
          await fetchMembers();
          renderPersonalTodos(); // 이름이 바뀌면 owner 기준 필터링 결과도 바뀔 수 있어서 다시 그림
        } catch (err) {
          console.error('[memberRegister] 실패(오프라인 등) — 이름은 저장됐고, 명단 등록은 나중에 다시 시도됨', err);
        }
      }
      resolve();
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', onKey);
    closeBtn.addEventListener('click', onCancel);
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}
function ensureUserName() {
  if (localData.userName) return Promise.resolve();
  return openNamePrompt(false); // 최초 1회는 취소 불가(이름 없이는 못 닫음)
}
function editUserName() {
  return openNamePrompt(true); // 설정 메뉴에서 다시 열 땐 취소 가능
}

// 예전(웹 연동 전) 로컬 전용 My Notes가 남아있으면 딱 한 번만 웹으로 그대로 옮김 — 안 그러면
// 업데이트하는 순간 그동안 적어둔 개인 노트들이 안 보이게(사라진 것처럼) 될 뻔했음
async function migrateLocalTasksIfNeeded() {
  if (localData.tasksMigrated) return;
  const old = localData.personalTodos || [];
  if (!old.length) { // 옮길 게 없으면 바로 완료 처리(다음부턴 빈 배열 확인하러 매번 안 돌게)
    localData.tasksMigrated = true;
    persistLocalData();
    return;
  }
  try {
    for (const parent of old) {
      const res = await apiPost({ action: 'taskAdd', text: parent.text, owner: localData.userName, assignee: '', parentId: '', order: 0 });
      if (!res.ok) throw new Error('taskAdd 실패: ' + (res.error || '알 수 없는 오류'));
      if (parent.done) await apiPost({ action: 'taskToggle', id: res.id });
      for (const child of (parent.children || [])) {
        const cres = await apiPost({ action: 'taskAdd', text: child.text, owner: localData.userName, assignee: '', parentId: res.id, order: 0 });
        if (!cres.ok) throw new Error('taskAdd(자식) 실패: ' + (cres.error || '알 수 없는 오류'));
        if (child.done) await apiPost({ action: 'taskToggle', id: cres.id });
      }
    }
    // 전부 성공했을 때만 로컬 백업을 지움 — 오프라인이거나 서버 오류로 중간에 하나라도 실패하면
    // 여기 도달 못 하고 personalTodos가 그대로 남아서, 다음 실행 때 이관을 처음부터 다시 시도함
    // (이미 성공해서 올라간 것까지 같이 다시 올라가 중복될 순 있지만, 노트가 사라지는 것보단 나음)
    localData.tasksMigrated = true;
    localData.personalTodos = [];
    persistLocalData();
  } catch (err) {
    console.error('[migrate] 로컬 My Notes를 웹으로 옮기는 중 실패(오프라인 등) — 다음 실행 때 다시 시도됨', err);
  }
}

// ===== 설정 =====
const API_URL = 'https://script.google.com/macros/s/AKfycbyqj6Sgwq-eW9hKV0QsilqEE8xDPBOak3v0eDLEjfVHUyLIeJV7Uzgie6iadRNEf2UeBw/exec';
const WIDGET_MAX_H = 700;
// 달력 그리드는 항상 6주(42칸) 고정 렌더링이라(renderGrid 참고) 다이어리 모드 필요 높이는 달과
// 무관하게 항상 동일 — 실측(CDP)으로 확인한 값에 여유를 살짝 더함. 모드 진입 시 한 번만 쓰고,
// 그 뒤론 폭처럼 사용자가 우하단 핸들로 직접 조절(resizeToContent가 diaryMode일 때 손 안 댐)
const DIARY_FIXED_H = 670;
// 모달은 내용(반복 필드 펼침 등)에 따라 매번 정확히 측정하려다가 계속 버그가 났음(줌 배율,
// 타이밍 등) — 모달 자체가 이미 max-height:90vh + overflow-y:auto라 넘치면 알아서 스크롤되니,
// 그냥 넉넉한 고정 크기로 열고 모달 안쪽에서 스크롤로 해결함 (측정 안 하니 애초에 틀릴 일이 없음).
// 620이었을 때는 90vh(이전엔 86vh)로도 가장 단순한 경우(반복 없음, 실측 675px 필요)조차 다
// 못 보여줘서 항상 스크롤이 떴었음(실측으로 확인) — 그 경우는 스크롤 없이 다 보이게 올림. 반복
// 필드까지 다 펼친 최악의 경우(실측 약 818px)는 이 값으로도 살짝 스크롤이 남는데, 그 이상 올리면
// 화면이 작은 모니터(1366×768 등)에서 창이 화면 밖으로 넘어갈 수 있어 여기서 타협함
const MODAL_FIXED_H = 780;

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
// getBoundingClientRect는 소수점까지 정확 — scrollHeight(정수 반올림)로는 6주짜리 달(그리드 6행)에서
// 반올림 오차가 누적돼 마지막 행이 잘리는 문제가 있었음. body{zoom}은 실제 계산된 값을 읽어서 곱함 —
// 나중에 zoom 값이 바뀌어도 이 코드를 따로 안 고쳐도 항상 맞게 동작함
function measureContentHeight() {
  const target = document.getElementById('app').getBoundingClientRect().height;
  const bodyZoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
  return Math.ceil(Math.max(target * bodyZoom, 120)) + 6;
}
function resizeToContent() {
  // 다이어리 모드는 폭과 마찬가지로 높이도 사용자가 우하단 핸들로 직접 조절하게 둠(보드처럼 쓰는
  // 용도라 위젯처럼 매번 내용 크기로 자동으로 되돌리면 대각선 리사이즈가 먹통이 됨) — 모드
  // 진입/이탈 시점에만 setDiaryMode에서 직접 한 번 크기를 잡아주고, 그 뒤로는 손대지 않음
  if (diaryMode) return;
  const currentW = window.innerWidth;
  // 모달/팝업은 #app의 형제 요소(position:fixed)라 #app 크기 관찰만으론 안 잡혀서(measureContentHeight가
  // #app 기준이라 모달 내용은 아예 안 셈) 열려있는 동안은 무조건 이 고정 크기를 씀 — 안 그러면 위젯용
  // 작은 창 위에 모달만 넘치게 됨. nameBackdrop(최초 이름 입력)도 같은 이유로 여기 포함시켜야 함
  if ($('#modalBackdrop')?.classList.contains('open') || $('#recurringBackdrop')?.classList.contains('open') || $('#nameBackdrop')?.classList.contains('open') || $('#shareBackdrop')?.classList.contains('open') || $('#membersBackdrop')?.classList.contains('open')) {
    window.api?.resize?.(currentW, MODAL_FIXED_H);
    return;
  }
  const requestedH = Math.min(measureContentHeight(), WIDGET_MAX_H);
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

// ===== What's New (최근 5개만) =====
// 새 버전 낼 때 위에 하나 추가하고 5개 넘으면 맨 아래 것부터 빼면 됨. id는 안 겹치게만 하면 됨.
const UPDATE_LOG = [
  { id: 'u2026-privacy-fix', tag: 'fix', date: '7/28', text: '(중요) My Notes 공개범위 버그 수정 — 아무것도 안 정해도 전체공개였던 걸 "나만 보임"으로 기본값 변경, 공유 안 한 노트가 남에게 보이던 문제 해결. 남의 노트엔 작성자 이름표 표시. 공유 대상 지정/삭제는 만든 사람만, 받은 사람이 지우면 내 화면에서만 사라지고 원본은 안 지워짐' },
  { id: 'u2026-activity-dup-fix', tag: 'fix', date: '7/28', text: '일정 추가할 때 "추가됨"과 함께 의미없는 "삭제됨" 알림이 같이 뜨던 버그 수정' },
  { id: 'u2026-share-redesign', tag: 'improved', date: '7/28', text: 'My Notes 공유 방식 개선 — 항목마다 ↗ 버튼으로 대상 선택 후 "공유하기"로 확정(실수 방지), 받으면 알림 뜸. 추가할 때 지연 체감 없앰' },
  { id: 'u2026-shared-tasks', tag: 'new', date: '7/28', text: 'My Notes가 팀 공유 태스크로 — 최초 실행 시 이름 등록, 특정 팀원에게 보내기, 톱니 메뉴에서 이름 변경 가능' },
  { id: 'u2026-diary-polish', tag: 'improved', date: '7/27', text: '다이어리 모드 개선 — My Notes 드래그로 순서 변경, 달력/My Notes 폭 조절 핸들, 창 높이에 맞춰 내용 꽉 차게' },
  { id: 'u2026-update-fix', tag: 'fix', date: '7/27', text: '업데이트/자동실행 안정화 — 확인 안 눌러도 자동 진행되던 버그, 시작프로그램 오류 화면 뜨던 문제 수정' },
  { id: 'u2026-diary-mode', tag: 'new', date: '7/24', text: '다이어리 모드 — 제목표시줄 아이콘으로 옆으로 넓어지는 보드 형태(달력+My Notes+일정) 전환' },
];
// 빨간 점(배지)과 목록에서 지우는 건 서로 다른 상태임 —
// 배지는 팝업을 한 번 열어서 "확인"만 하면 사라짐(읽음 처리), 목록의 개별 항목은 ×로
// 하나씩 직접 지워야 없어짐(정리는 각자 원할 때만, 배지랑은 무관)
function getSeenUpdateIds() {
  try { return JSON.parse(localStorage.getItem('tkm_seen_updates') || '[]'); } catch { return []; }
}
function markAllUpdatesSeen() {
  localStorage.setItem('tkm_seen_updates', JSON.stringify(UPDATE_LOG.map(u => u.id)));
  markAllActivitySeen();
  renderUpdatesBadge();
}
function getDismissedUpdateIds() {
  try { return JSON.parse(localStorage.getItem('tkm_dismissed_updates') || '[]'); } catch { return []; }
}
function dismissUpdate(id) {
  const dismissed = new Set(getDismissedUpdateIds());
  dismissed.add(id);
  localStorage.setItem('tkm_dismissed_updates', JSON.stringify([...dismissed]));
  renderUpdatesList();
}

// ── 팀 일정 변경 알림(추가/수정/삭제 — 본인이 한 것도 포함) ──
// 실시간 웹훅이 없어서, 이미 한 번 봤던 달을 다시 불러올 때(2분 폴링/포커스 갱신) 직전 내용과
// 비교해서 차이를 활동 기록으로 남기는 방식. 그래서 "이 위젯에서 아직 한 번도 안 본 달"의
// 변경은 못 잡고, 감지도 몇 분 정도 늦을 수 있음(진짜 실시간 웹훅은 아님) — 알려진 한계.
const ACTIVITY_LABEL = { added: '추가됨', changed: '수정됨', deleted: '삭제됨' };
function diffAndLogActivity(oldEvents, newEvents) {
  const oldById = new Map(oldEvents.map(e => [e.id, e]));
  const newById = new Map(newEvents.map(e => [e.id, e]));
  newById.forEach((ev, id) => {
    const old = oldById.get(id);
    if (!old) logActivity('added', ev);
    else if (old.title !== ev.title || old.date !== ev.date || old.time !== ev.time || old.category !== ev.category) {
      logActivity('changed', ev);
    }
  });
  oldById.forEach((ev, id) => {
    if (!newById.has(id)) logActivity('deleted', ev);
  });
}
function logActivity(type, ev) {
  localData.calendarActivity ??= [];
  localData.calendarActivity.unshift({
    id: 'act-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    type, title: ev.title, date: ev.date, ts: Date.now()
  });
  localData.calendarActivity = localData.calendarActivity.slice(0, 20); // 최대 20개만 보관
  persistLocalData();
  renderUpdatesBadge();
}
function dismissActivity(id) {
  localData.calendarActivity = (localData.calendarActivity || []).filter(a => a.id !== id);
  persistLocalData();
  renderUpdatesList();
}
function markAllActivitySeen() {
  localStorage.setItem('tkm_activity_seen_at', String(Date.now()));
}
function hasUnseenActivity() {
  const seenAt = parseInt(localStorage.getItem('tkm_activity_seen_at') || '0', 10);
  return (localData.calendarActivity || []).some(a => a.ts > seenAt);
}

function renderUpdatesBadge() {
  const seen = getSeenUpdateIds();
  const hasUnseenUpdate = UPDATE_LOG.some(u => !seen.includes(u.id));
  const hasUnseen = hasUnseenUpdate || hasUnseenActivity();
  $('#updatesBadge').hidden = !hasUnseen;
  $('#collapsedBadge').hidden = !hasUnseen; // 접힘 모드에서도 같은 상태로 표시
}

function renderUpdatesList() {
  const list = $('#updatesList');
  list.innerHTML = '';

  const activity = localData.calendarActivity || [];
  const dismissedUpdates = getDismissedUpdateIds();
  const updates = UPDATE_LOG.filter(u => !dismissedUpdates.includes(u.id));

  if (!activity.length && !updates.length) {
    list.innerHTML = '<li class="updates-empty">새 소식 없음</li>';
    resizeToContent();
    return;
  }

  if (activity.length) {
    const label = document.createElement('li');
    label.className = 'updates-group-label';
    label.textContent = 'Team Calendar';
    list.appendChild(label);
    activity.forEach(a => {
      const tagClass = a.type; // added | changed | deleted — 그대로 CSS 클래스명으로 씀
      list.appendChild(buildUpdateRow(tagClass, ACTIVITY_LABEL[a.type], `${a.date} · ${a.title}`, () => dismissActivity(a.id)));
    });
  }
  if (updates.length) {
    const label = document.createElement('li');
    label.className = 'updates-group-label';
    label.textContent = "What's New";
    list.appendChild(label);
    updates.forEach(u => {
      list.appendChild(buildUpdateRow(u.tag, u.tag, `${u.date} · ${u.text}`, () => dismissUpdate(u.id)));
    });
  }
  resizeToContent();
}

function buildUpdateRow(tagClass, tagLabel, text, onDismiss) {
  const li = document.createElement('li');
  li.className = 'update-row';
  const tag = document.createElement('span');
  tag.className = 'tag ' + tagClass;
  tag.textContent = tagLabel;
  li.appendChild(tag);
  const body = document.createElement('div');
  body.className = 'body';
  const textEl = document.createElement('span');
  textEl.className = 'text';
  textEl.textContent = text; // XSS 방지 — innerHTML 대신 textContent
  body.appendChild(textEl);
  li.appendChild(body);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'dismiss';
  dismiss.textContent = '×';
  dismiss.title = '확인함';
  dismiss.addEventListener('click', onDismiss); // 확인한 사람이 직접 하나씩 닫음 — 자동으로 안 없어짐
  li.appendChild(dismiss);
  return li;
}

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

  // 로컬 전용 데이터(최근 업무, 개인 일정) — 네트워크 필요 없이 바로 로드
  await loadLocalData();
  renderUpdatesBadge();
  if (localData.icsUrl) syncPersonalIcs(); // 개인 ICS 연동해뒀으면 백그라운드로 바로 한 번 동기화

  // My Notes(공유 태스크) — 최초 1회 이름 확인 → 예전 로컬 데이터 있으면 웹으로 이관 → 팀원
  // 명단·태스크 목록 로드. 이 넷은 순서가 중요해서(이름 있어야 이관/등록 가능) await로 순차 실행
  await ensureUserName();
  if ($('#manageMembersBtn')) $('#manageMembersBtn').hidden = localData.userName !== ADMIN_NAME;
  await migrateLocalTasksIfNeeded();
  fetchMembers();
  fetchSharedTasks();
  setInterval(() => {
    if (document.visibilityState === 'visible') fetchSharedTasks();
  }, 120000); // 2분 — 팀 일정 폴링과 같은 주기

  window.api?.getAutoLaunch?.().then(on => {
    $('#autoLaunchBtn')?.classList.toggle('active', !!on);
  });

  // 커스텀 드래그 이동(-webkit-app-region:drag 대신) — 그 CSS를 쓰면 Windows가 이 영역의
  // 마우스 이벤트를 OS 레벨에서 가로채서 click/dblclick 자체가 렌더러에 전혀 안 들어오는 문제가
  // 실측으로 확인됐음. 그래서 직접 mousedown/mousemove로 창을 옮김 — 더블클릭 구분은 포기하고
  // 그냥 "드래그로 움직이지 않았으면 클릭 한 번으로 펼침, 움직였으면 이동만"으로 단순화함
  function isDragArea(target) {
    if (target.closest('button')) return false; // 아이콘/이전달/다음달 버튼 등은 제외
    if (target.closest('.title-bar')) return true;
    if (document.getElementById('app').classList.contains('unfocused') && target.closest('.topbar')) return true;
    return false;
  }
  let dragStart = null;
  let dragMoved = false; // 드래그로 창을 옮긴 직후엔 그 뒤에 뜨는 click으로 펼쳐지지 않게 막는 용도
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !isDragArea(e.target)) return;
    dragStart = { x: e.screenX, y: e.screenY };
    dragMoved = false;
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    const dx = e.screenX - dragStart.x, dy = e.screenY - dragStart.y;
    if (!dx && !dy) return;
    dragMoved = true;
    window.api?.moveBy?.(dx, dy);
    dragStart = { x: e.screenX, y: e.screenY };
  });
  document.addEventListener('mouseup', () => { dragStart = null; });

  // Tack처럼 위젯 창이 포커스를 잃으면 열려있던 모달/팝업을 정리하고 달력만 남김
  window.api?.onBlur?.(closeAllOverlaysOnBlur);
  // 포커스를 얻는 것 자체(win-focus)로는 안 펼침 — 손잡이를 눌러서 창을 옮기기만 해도
  // OS 포커스는 얻어지기 때문에, 펼치는 건 "실제로 클릭(드래그 아님)했을 때"로만 판단함
  document.addEventListener('click', (e) => {
    if (suppressNoteClick) { suppressNoteClick = false; return; } // 방금 노트 드래그로 순서 바꾼 직후 — 펼침도 편집도 트리거 안 함
    const app = document.getElementById('app');
    if (!app.classList.contains('unfocused')) return;
    if (dragMoved) { dragMoved = false; return; } // 방금 드래그로 옮긴 거면 무시(어디서 손을 떼든 펼쳐지면 안 됨)
    if (e.target.closest('.todo-check') || e.target.closest('.todo-del') || e.target.closest('.todo-add-child')) return; // 체크박스/삭제/하위추가만 접힌 채로 처리, My Notes 나머지 부분은 눌러도 펼쳐짐
    restoreOverlaysOnFocus();
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

  // 개인 ICS도 비슷하게 주기적으로 재동기화(연동해둔 경우만)
  setInterval(() => {
    if (localData.icsUrl && document.visibilityState === 'visible') syncPersonalIcs();
  }, 600000); // 10분 간격 — 외부 서비스 부담 덜 주게 팀 캘린더보다 느슨하게

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
    // 사본을 씀(참조를 그대로 넘기지 않음) — state.events는 낙관적 업데이트(추가/수정 시 서버
    // 응답 기다리기 전에 push/수정)로 자주 그 자리에서 바로 mutate되는데, cached를 그대로 넘기면
    // monthCache에 저장된 "진짜 예전 목록"까지 같이 오염돼서 diffAndLogActivity가 잘못된 비교를
    // 하게 됨(임시 id 항목이 낀 "예전 목록"과 서버의 "새 목록"을 비교 → 그 임시 항목만 서버엔
    // 없으니 "삭제됨"으로 오탐 — 일정 추가할 때마다 추가됨+삭제됨이 짝지어 뜨던 원인)
    state.events = [...cached];
  } else if (state.loadedYear !== y || state.loadedMonth !== m) {
    state.events = []; // 처음 보는 달이라 어쩔 수 없이 비워서 표시(다른 달 점이 잘못 보이는 것 방지)
  }
  state.loadedYear = y; state.loadedMonth = m;
  renderAll();

  const res = await apiGet({ action: 'list', year: y, month: m });
  if (myToken !== loadToken) return; // 응답 오는 사이 다른 달로 이동함 — 이 결과는 폐기
  if (res.ok) {
    if (cached) diffAndLogActivity(cached, res.events); // 이미 본 적 있는 달일 때만 비교 — 처음 보는 달은 전부 "추가됨"으로 오폭되는 걸 방지
    monthCache.set(key, res.events);
    state.events = [...res.events]; // 위와 같은 이유로 사본 — monthCache에 저장된 배열과 별개로 둠
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
  grid.className = 'grid mode-' + state.viewMode + (diaryMode ? ' diary' : '');

  const firstDow = new Date(state.year, state.month - 1, 1).getDay(); // 0=일
  const daysInMonth = new Date(state.year, state.month, 0).getDate();
  const daysInPrevMonth = new Date(state.year, state.month - 1, 0).getDate();

  const eventsByDate = {};
  for (const ev of [...state.events, ...personalEventsForMonth(state.year, state.month), ...icsEventsForMonth(state.year, state.month)]) {
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
      if (state.viewMode === 'max' || diaryMode) {
        // 다이어리 모드는 칸이 훨씬 넉넉해서(위 CSS .grid.diary .cell) 최대 5개까지 그대로 보여줌 —
        // 평소 최대 모드는 지금까지처럼 3개로 유지(칸 크기가 그대로라 5개는 안 들어감)
        const cap = diaryMode ? 5 : 3;
        const chipsWrap = document.createElement('div');
        chipsWrap.className = 'chips-wrap';
        dayEvents.slice(0, cap).forEach(ev => {
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
        if (dayEvents.length > cap) {
          const more = document.createElement('div');
          more.className = 'chip-more';
          more.textContent = `+${dayEvents.length - cap} more`;
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

  const dayEvents = [...state.events, ...personalEventsForMonth(state.year, state.month), ...icsEventsForMonth(state.year, state.month)]
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
    const rest = [ev.isIcs ? 'My Calendar' : (ev.isPersonal ? 'Personal' : null), ev.category, ev.author, ev.isRecurring ? '↻ 반복' : ''].filter(Boolean).join(' · ');
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

    // ICS로 가져온 외부 캘린더 일정은 읽기 전용 — 우리 쪽에서 수정/삭제할 방법이 없음(원본은 그쪽 캘린더에 있음)
    if (!ev.isIcs) {
      const del = document.createElement('button');
      del.className = 'event-del';
      del.textContent = '×';
      del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(ev); });
      li.appendChild(del);

      li.addEventListener('click', () => openEditModal(ev));
    } else {
      li.classList.remove('clickable');
    }

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

// ===== 다이어리 모드 =====
// 기존 위젯 모습·기능은 전혀 안 건드리고, 버튼 하나로 옆으로 넓어지는 겉모습(폼)만 추가함.
// 왼쪽 달력 칸도 같이 넉넉해져서 하루 일정을 최대 5개까지 그대로 보여주고(renderGrid의 diaryMode
// 분기), 오른쪽엔 My Notes(위)·당일 일정(아래)이 새로 생김 — 실제 DOM은 복제하지 않고
// #dayPanel/#personalTodo 노드를 그대로 옮겨서(reparent) 렌더링 로직 중복을 피함.
let diaryMode = false;
let widthBeforeDiary = null;
const DIARY_EXTRA_W = 300; // .diary-col 너비만큼 창을 더 넓힘
// 다이어리 모드는 내용이 창 크기에 맞춰 늘어나고 줄어들어서(그리드가 남는 공간을 다 채움),
// 너무 작으면 칸이 못 알아보게 찌그러짐 — 그래서 이 모드에서만 최소 크기를 더 크게 잡음
const DIARY_MIN_W = 520, DIARY_MIN_H = 480;
const WIDGET_MIN_W = 220, WIDGET_MIN_H = 100; // main/index.js의 BrowserWindow 기본값과 일치
// 달력/My Notes 칸 폭 조절 핸들의 최소값 — 이 이상 좁아지면 못 알아보므로 드래그가 여기서 멈춤
const MIN_CAL_COL_W = 260, MIN_DIARY_COL_W = 220;

function setDiaryMode(on) {
  if (diaryMode === on) return;
  diaryMode = on;
  const app = document.getElementById('app');
  app.classList.toggle('diary-mode', on);
  $('#diaryModeBtn').classList.toggle('active', on);
  window.api?.setMinSize?.(on ? DIARY_MIN_W : WIDGET_MIN_W, on ? DIARY_MIN_H : WIDGET_MIN_H);

  const widgetSlot = $('#widgetListSlot');
  const diarySlot = $('#diaryListSlot');
  let targetW;
  if (on) {
    widthBeforeDiary = window.innerWidth;
    // 다이어리 모드에선 최대 모드의 "접힘" 설정과 무관하게 항상 펼쳐서 보여줌(접으면 오른쪽 패널에서 보일 게 없어짐)
    state.dayPanelCollapsed = false;
    updateDayPanelVisibility();
    diarySlot.appendChild($('#personalTodo')); // My Notes를 위로
    diarySlot.appendChild($('#dayPanel'));      // 당일 일정을 아래로
    targetW = widthBeforeDiary + DIARY_EXTRA_W;
  } else {
    // 원래 순서(dayPanel -> divider -> personalTodo)로 복원
    widgetSlot.insertBefore($('#dayPanel'), $('#listDivider'));
    widgetSlot.appendChild($('#personalTodo'));
    targetW = widthBeforeDiary || window.innerWidth;
    // 핸들로 조절했던 폭 비율(인라인 style)을 지움 — 안 지우면 위젯 모드에서도 그 값이 그대로
    // 적용돼서(인라인 스타일이 CSS 클래스보다 항상 우선) 레이아웃이 깨짐. 다음에 다시 들어오면
    // 기본 비율(58:42)로 새로 시작함
    $('#calCol').style.flex = '';
    $('#diaryCol').style.flex = '';
  }

  renderGrid();
  renderDayPanel();

  if (on) {
    // window.innerWidth/innerHeight는 네이티브 창 크기 변경 직후 곧바로 안 갱신되고 한 프레임 정도
    // 늦게 반영됨 — 그 값을 곧바로 실측해서 되쓰면 "좁고 길게" 같은 엉뚱한 크기로 잘못 열리는 문제가
    // 있었음(실측으로 확인). 다행히 달력 그리드는 달이 몇 주짜리든 항상 6주(42칸)로 고정 렌더링돼서
    // (renderGrid 참고) 다이어리 모드의 필요 높이는 달과 무관하게 항상 똑같음 — 그래서 실측 대신
    // 미리 확인해둔 고정값을 씀. 그 뒤로는 폭과 똑같이 사용자가 우하단 핸들로 직접 조절하게 둠
    // (위 resizeToContent의 diaryMode 조기 반환 참고)
    window.api?.resize?.(targetW, DIARY_FIXED_H);
  } else {
    // 위젯 모드 레이아웃은 세로 한 줄 쌓기라 높이가 폭에 안 좌우됨 — 그래서 폭을 바꾸기 전에
    // (아직 다이어리 폭인 채로) 미리 실측해도 정확함. 이렇게 하면 폭+높이를 한 번에 같이
    // 맞출 수 있어서, 진입 때와 마찬가지로 "좁고 길게/넓고 짧게" 같은 중간 단계 없이 바로 최종
    // 크기로 열림
    const finalH = Math.min(measureContentHeight(), WIDGET_MAX_H);
    window.api?.resize?.(targetW, finalH);
    // resettleSize()는 여기서 쓰면 안 됨 — window.innerWidth가 방금 요청한 폭으로 실제 갱신되기
    // 전에(한 프레임 지연) resizeToContent()가 먼저 돌면서 "아직 옛 폭(다이어리 모드 폭)"을 그대로
    // 읽어다 다시 그 폭으로 resize를 호출해버려서, 방금 줄인 폭이 도로 넓어지는 버그가 있었음
    // (실측으로 확인 — 다이어리 모드 해제해도 창이 안 줄어들던 문제의 원인). 폰트 로딩 등 뒤늦은
    // 변화 보정은 다음 프레임부터 안전하게 재개
    requestAnimationFrame(() => requestAnimationFrame(resettleSize));
  }
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
  if (diaryMode) return; // 다이어리 모드는 보드처럼 계속 펼쳐져 있어야 하므로 포커스를 잃어도 접지 않음
  if ($('#modalBackdrop').classList.contains('open')) closeAddModal();
  if ($('#recurringBackdrop').classList.contains('open')) { $('#recurringBackdrop').classList.remove('open'); resizeToContent(); }
  if ($('#icsBackdrop').classList.contains('open')) { $('#icsBackdrop').classList.remove('open'); resizeToContent(); }
  $('#updatesPopover').classList.remove('open');
  $('#updatesBackdrop').classList.remove('open');
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

  // My Notes(팀 공유 태스크) — 입력 후 엔터로 추가
  $('#todoInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addPersonalTodo($('#todoInput').value);
      $('#todoInput').value = '';
    }
  });
  $('#closeShareModal').addEventListener('click', closeShareModal);
  $('#shareBackdrop').addEventListener('click', (e) => { if (e.target.id === 'shareBackdrop') closeShareModal(); });

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
    const btn = $('#autoLaunchBtn');
    if (btn.disabled) return; // 처리 중 중복 클릭 방지
    const wasOn = btn.classList.contains('active');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '처리 중...'; // 시작프로그램 폴더에 바로가기를 만들고 지우는 동안(순간적이지만) 눌러도 반응 없어 보이지 않게
    resizeToContent();
    const next = await window.api?.toggleAutoLaunch?.();
    btn.disabled = false;
    btn.classList.toggle('active', !!next);
    // 끄려던 게 아니었는데 꺼진 상태로 남았으면 = 켜기 자체가 실패한 것(권한 문제 등) — 알려줌
    btn.textContent = (!wasOn && !next) ? '실패 — 다시 시도' : original;
    resizeToContent();
    if (!wasOn && !next) setTimeout(() => { btn.textContent = original; resizeToContent(); }, 2500);
  });

  // ── 업데이트 — 평범한 앱처럼 심플하게: 실행할 때 딱 한 번 조회, 있으면 "업데이트 하시겠습니까?"
  // 확인창 하나만 뜨고, Yes면 알아서 받아서 재시작까지 자동. 수동 확인 버튼은 없고 이 자리엔
  // 평소엔 그냥 현재 버전 번호만 표시 ──
  let updateConfirmAsked = false; // 같은 버전에 대해 확인창 중복으로 안 뜨게
  const updateStatusEl = $('#updateStatus');
  window.api?.getAppVersion?.().then((v) => { if (updateStatusEl && v) updateStatusEl.textContent = `TKM Calendar v${v}`; });
  window.api?.onUpdateStatus?.((data) => {
    if (data.status === 'available') {
      if (updateConfirmAsked) return;
      updateConfirmAsked = true;
      if (safeConfirm(`업데이트 발견 (v${data.extra})\n업데이트 하시겠습니까?`)) {
        if (updateStatusEl) updateStatusEl.textContent = '다운로드 중...';
        window.api?.confirmUpdate?.();
        resizeToContent();
      }
      return;
    }
    if (data.status === 'downloading' && updateStatusEl) {
      updateStatusEl.textContent = `다운로드 중... ${data.extra}%`;
      resizeToContent();
    } else if (data.status === 'downloaded' && updateStatusEl) {
      updateStatusEl.textContent = `설치 중입니다 — 곧 v${data.extra}로 재시작됩니다...`;
      resizeToContent();
    }
  });

  // ── What's New (종 아이콘) — 빨간 점은 한 번 열어보면 사라짐(읽음 처리),
  // 목록의 항목 하나하나는 ×로 직접 지워야 없어짐(배지랑은 별개, 정리용) ──
  $('#updatesBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    renderUpdatesList();
    $('#updatesPopover').classList.toggle('open');
    $('#updatesBackdrop').classList.toggle('open');
    markAllUpdatesSeen();
    resizeToContent();
  });
  $('#updatesBackdrop').addEventListener('click', () => {
    $('#updatesPopover').classList.remove('open');
    $('#updatesBackdrop').classList.remove('open');
    resizeToContent();
  });

  // ── 개인 ICS 캘린더 설정 ──
  $('#openIcsSettings').addEventListener('click', () => {
    closePopover();
    $('#fIcsUrl').value = localData.icsUrl || '';
    $('#icsHint').textContent = '';
    $('#icsBackdrop').classList.add('open');
    resizeToContent();
  });
  $('#closeIcs').addEventListener('click', () => { $('#icsBackdrop').classList.remove('open'); resizeToContent(); });

  // ── 내 이름 바꾸기 ──
  $('#editUserNameBtn')?.addEventListener('click', () => {
    closePopover();
    editUserName();
  });

  // ── 회원 관리(관리자 전용 버튼 — hidden 해제는 init()에서) ──
  $('#manageMembersBtn')?.addEventListener('click', () => {
    closePopover();
    openMembersModal();
  });
  $('#closeMembersModal').addEventListener('click', closeMembersModal);
  $('#membersBackdrop').addEventListener('click', (e) => { if (e.target.id === 'membersBackdrop') closeMembersModal(); });

  // ── 태스크 공유 대상 선택 확정 버튼 ──
  $('#confirmShareBtn').addEventListener('click', confirmShareTarget);
  $('#icsBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'icsBackdrop') { $('#icsBackdrop').classList.remove('open'); resizeToContent(); }
  });
  $('#saveIcsUrl').addEventListener('click', async () => {
    const url = $('#fIcsUrl').value.trim();
    localData.icsUrl = url;
    persistLocalData();
    if (!url) {
      icsEvents = {};
      $('#icsHint').textContent = '연동 해제됨.';
      renderGrid(); renderDayPanel();
      return;
    }
    $('#icsHint').textContent = '불러오는 중...';
    const result = await syncPersonalIcs();
    $('#icsHint').textContent = result.ok
      ? `동기화 완료 (${result.count}개 일정 찾음)`
      : `실패: ${result.error}`;
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

  // ── 다이어리 모드 (버튼 하나로 옆으로 넓어지는 보드 형태, 기존 위젯은 그대로 유지) ──
  $('#diaryModeBtn').addEventListener('click', () => setDiaryMode(!diaryMode));

  // ── 다이어리 모드: 달력/My Notes 폭 조절 핸들 ──
  // clientX는 실제(post-zoom) 좌표계인데 getBoundingClientRect()는 pre-zoom(1.25배 큰) 좌표계라
  // 그대로 섞어 쓰면 어긋남(여백 버그와 같은 원인) — bodyZoom을 곱해서 같은 좌표계로 맞춤
  $('#diaryDivider').addEventListener('mousedown', (e) => {
    if (!diaryMode || e.button !== 0) return;
    e.preventDefault();
    const calCol = $('#calCol'), diaryColEl = $('#diaryCol'), divider = $('#diaryDivider');
    divider.classList.add('active');
    const onMove = (ev) => {
      const bodyZoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
      const calLeft = calCol.getBoundingClientRect().left * bodyZoom;
      const totalW = (calCol.getBoundingClientRect().width + diaryColEl.getBoundingClientRect().width) * bodyZoom;
      let calW = ev.clientX - calLeft;
      calW = Math.max(MIN_CAL_COL_W, Math.min(calW, totalW - MIN_DIARY_COL_W));
      const calRatio = (calW / totalW) * 100;
      calCol.style.flex = `${calRatio} 1 0`;
      diaryColEl.style.flex = `${100 - calRatio} 1 0`;
    };
    const onUp = () => {
      divider.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
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
