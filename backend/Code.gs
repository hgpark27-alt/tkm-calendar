/**
 * TKM 캘린더 — Apps Script 백엔드
 * 배포 방법: SETUP.md 참고
 *
 * 사전 준비 (script.google.com 프로젝트에서):
 *   1. 좌측 "서비스" (+) 클릭 → "Calendar API" 추가 (Advanced Google Services)
 *   2. 아래 CALENDAR_ID가 실제 공유 캘린더와 일치하는지 확인
 */

// ===== 설정 =====
const CALENDAR_ID = '4b9c15c5a0e715482c08ecf5b10482391754fd997bb4fe7d5b3615cb5991b31c@group.calendar.google.com';

// 공유 태스크(My Notes 공유 항목) 저장용 구글 시트 — 캘린더와는 완전히 별개 저장소.
// 1. drive.google.com에서 새 스프레드시트 하나 만들기(이름 아무거나, 예: "TKM Shared Tasks")
// 2. 주소창 URL에서 /d/ 와 /edit 사이의 긴 문자열이 시트 ID — 그걸 아래에 붙여넣기
// 3. 시트 자체엔 아무것도 안 적어도 됨 — 처음 호출될 때 코드가 알아서 헤더 행을 만듦
const TASKS_SHEET_ID = '1eItxuKa_bGT6yE9S9F0Jo4JwLzxiayU1FYzC3-0pWXU';

// 카테고리 → Google Calendar colorId(1~11) 매핑. 이 순서가 그대로 프론트엔드 칩 표시 순서가 됨.
// 카테고리 추가 시 여기에만 한 줄 추가하면 됨.
const CATEGORY_COLORS = {
  '자료': '5',   // Banana
  '미팅': '9',   // Blueberry
  '교육': '3',   // Grape
  '내방': '10',  // Basil
  '행사': '11',  // Tomato
  '기타': '8',   // Graphite
};
const DEFAULT_COLOR = '8'; // Graphite — 매핑 안 된 카테고리 기본값(=기타와 동일 색)

// ===== 진입점 (GET: 조회) =====
function doGet(e) {
  return respond(() => {
    const action = e.parameter.action;
    if (action === 'list') {
      return { events: listEvents(e.parameter.year, e.parameter.month) };
    }
    if (action === 'categories') {
      return { categories: CATEGORY_COLORS };
    }
    if (action === 'ping') {
      return { pong: true, calendarId: CALENDAR_ID };
    }
    if (action === 'list-recurring') {
      return { series: listRecurringSeries() };
    }
    if (action === 'holidays') {
      return { holidays: getKrHolidays() };
    }
    if (action === 'tasksList') {
      return { tasks: listTasks() };
    }
    if (action === 'membersList') {
      return { members: listMembers() };
    }
    throw new Error('알 수 없는 action: ' + action);
  });
}

// ===== 진입점 (POST: 추가/수정/삭제) =====
function doPost(e) {
  return respond(() => {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'add')    return { event: addEvent(body) };
    if (body.action === 'update') return { event: updateEvent(body) };
    if (body.action === 'delete') return deleteEvent(body.eventId, body.deleteSeries);
    if (body.action === 'taskAdd')     return addTask(body);
    if (body.action === 'taskToggle')  return toggleTask(body);
    if (body.action === 'taskUpdate')  return updateTaskText(body);
    if (body.action === 'taskAssign')  return assignTask(body);
    if (body.action === 'taskDelete')  return deleteTask(body.id);
    if (body.action === 'taskReorder') return reorderTask(body);
    if (body.action === 'memberRegister') return registerMember(body.name);
    if (body.action === 'memberRename') return renameMember(body);
    if (body.action === 'memberDelete') return deleteMember(body);
    throw new Error('알 수 없는 action: ' + body.action);
  });
}

function respond(fn) {
  let payload;
  try {
    payload = { ok: true, ...fn() };
  } catch (err) {
    payload = { ok: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 조회 =====
function listEvents(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10); // 1~12
  const timeMin = new Date(y, m - 1, 1).toISOString();
  const timeMax = new Date(y, m, 1).toISOString(); // 다음달 1일(배타적 상한)

  const resp = Calendar.Events.list(CALENDAR_ID, {
    timeMin: timeMin,
    timeMax: timeMax,
    singleEvents: true, // 반복 일정을 실제 발생 건별로 펼쳐서 반환
    orderBy: 'startTime',
    maxResults: 2500
  });

  return (resp.items || []).map(function (ev) {
    const shared = (ev.extendedProperties && ev.extendedProperties.shared) || {};
    const isAllDay = !!ev.start.date; // date만 있으면 하루종일, dateTime이면 시간 지정됨
    return {
      id: ev.id,
      recurringEventId: ev.recurringEventId || null,
      isRecurring: !!ev.recurringEventId,
      title: ev.summary || '',
      date: isAllDay ? ev.start.date : (ev.start.dateTime || '').slice(0, 10),
      time: isAllDay ? null : (ev.start.dateTime || '').slice(11, 16), // 'HH:mm' 또는 null
      allDay: isAllDay,
      category: shared.category || '',
      author: shared.author || '',
      colorId: ev.colorId || DEFAULT_COLOR
    };
  });
}

// 반복 일정 마스터만 조회 (인스턴스로 펼치지 않음) — "반복 일정 관리" 화면 전용
function listRecurringSeries() {
  const now = new Date();
  const future = new Date();
  future.setMonth(future.getMonth() + 13); // 반복 기본 종료(1년)보다 넉넉하게
  const resp = Calendar.Events.list(CALENDAR_ID, {
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: false,
    maxResults: 250
  });
  return (resp.items || [])
    .filter(function (ev) { return ev.recurrence && ev.recurrence.length; })
    .map(function (ev) {
      const shared = (ev.extendedProperties && ev.extendedProperties.shared) || {};
      return {
        id: ev.id,
        title: ev.summary || '',
        category: shared.category || '',
        author: shared.author || '',
        colorId: ev.colorId || DEFAULT_COLOR,
        rrule: ev.recurrence[0] || '',
        startDate: ev.start.date || (ev.start.dateTime || '').slice(0, 10)
      };
    });
}

// 시간 문자열('HH:mm')에 기본 1시간을 더해 종료시각 계산 (자정 넘어가면 다음날로)
function addOneHour_(dateStr, timeStr) {
  const parts = timeStr.split(':').map(Number);
  let totalMin = parts[0] * 60 + parts[1] + 60;
  let endDate = dateStr;
  if (totalMin >= 24 * 60) {
    totalMin -= 24 * 60;
    const d = new Date(dateStr + 'T00:00:00+09:00');
    d.setDate(d.getDate() + 1);
    endDate = Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd');
  }
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  const pad2 = function (n) { return String(n).padStart(2, '0'); };
  return endDate + 'T' + pad2(h) + ':' + pad2(m) + ':00';
}

// ===== 추가 =====
// payload: { title, date:'YYYY-MM-DD', time:'HH:mm'|null, category, author, repeat: { freq, byday, intervalDays, until } }
function addEvent(payload) {
  const category = payload.category || '';
  const colorId = CATEGORY_COLORS[category] || DEFAULT_COLOR;

  const resource = {
    summary: payload.title,
    colorId: colorId,
    extendedProperties: {
      shared: { category: category, author: payload.author || '' }
    }
  };

  if (payload.time) {
    // 시간 지정 — 기본 1시간짜리 일정 (종료시각 UI 없음, 필요해지면 나중에 추가)
    resource.start = { dateTime: payload.date + 'T' + payload.time + ':00', timeZone: 'Asia/Seoul' };
    resource.end   = { dateTime: addOneHour_(payload.date, payload.time), timeZone: 'Asia/Seoul' };
  } else {
    // 시간 미지정 — 하루종일
    resource.start = { date: payload.date };
    resource.end   = { date: payload.date };
  }

  if (payload.repeat && payload.repeat.freq && payload.repeat.freq !== 'none') {
    resource.recurrence = [buildRRule(payload.repeat, payload.date)];
  }

  const created = Calendar.Events.insert(resource, CALENDAR_ID);
  return {
    id: created.id,
    title: payload.title,
    date: payload.date,
    time: payload.time || null,
    allDay: !payload.time,
    category: category,
    author: payload.author || '',
    colorId: colorId,
    isRecurring: !!created.recurrence
  };
}

// repeat = { freq: 'weekly'|'biweekly'|'custom', byday:['MO',...], intervalDays: N, until:'YYYY-MM-DD'(선택) }
function buildRRule(repeat, startDate) {
  const start = new Date(startDate + 'T00:00:00');
  const until = repeat.until
    ? new Date(repeat.until + 'T23:59:59')
    : new Date(start.getFullYear() + 1, start.getMonth(), start.getDate()); // 기본 1년, 무기한 금지
  const untilStr = Utilities.formatDate(until, 'Etc/UTC', "yyyyMMdd'T'HHmmss'Z'");

  if (repeat.freq === 'weekly') {
    const byday = (repeat.byday && repeat.byday.length) ? (';BYDAY=' + repeat.byday.join(',')) : '';
    return 'RRULE:FREQ=WEEKLY' + byday + ';UNTIL=' + untilStr;
  }
  if (repeat.freq === 'biweekly') {
    const byday = (repeat.byday && repeat.byday.length) ? (';BYDAY=' + repeat.byday.join(',')) : '';
    return 'RRULE:FREQ=WEEKLY;INTERVAL=2' + byday + ';UNTIL=' + untilStr;
  }
  if (repeat.freq === 'custom') {
    const n = parseInt(repeat.intervalDays, 10) || 1;
    return 'RRULE:FREQ=DAILY;INTERVAL=' + n + ';UNTIL=' + untilStr;
  }
  throw new Error('알 수 없는 반복 유형: ' + repeat.freq);
}

// ===== 수정 =====
// 반복 패턴(recurrence)은 여기서 건드리지 않음 — eventId가 인스턴스면 그 날짜만 예외 처리되고,
// 마스터 id면 시리즈 전체에 반영됨(둘 다 Google Calendar API 기본 동작 그대로).
function updateEvent(payload) {
  const existing = Calendar.Events.get(CALENDAR_ID, payload.eventId);
  const wasAllDay = !!existing.start.date;
  const willBeAllDay = !payload.time;

  const category = payload.category || '';
  const colorId = CATEGORY_COLORS[category] || DEFAULT_COLOR;
  const extendedProperties = { shared: { category: category, author: payload.author || '' } };

  // 하루종일 ↔ 시간지정 전환은 Calendar.Events.patch로 직접 안 됨("Invalid start time" 에러,
  // 실측으로 확인된 Google Calendar API 제약) → 삭제 후 같은 내용으로 재생성해서 우회
  if (wasAllDay !== willBeAllDay) {
    const resource = { summary: payload.title, colorId: colorId, extendedProperties: extendedProperties };
    if (payload.time) {
      resource.start = { dateTime: payload.date + 'T' + payload.time + ':00', timeZone: 'Asia/Seoul' };
      resource.end   = { dateTime: addOneHour_(payload.date, payload.time), timeZone: 'Asia/Seoul' };
    } else {
      resource.start = { date: payload.date };
      resource.end   = { date: payload.date };
    }
    if (existing.recurrence) resource.recurrence = existing.recurrence; // 반복 마스터였다면 패턴 유지

    Calendar.Events.remove(CALENDAR_ID, payload.eventId);
    const created = Calendar.Events.insert(resource, CALENDAR_ID);
    return { id: created.id, recreated: true };
  }

  // 같은 타입(하루종일→하루종일, 시간지정→시간지정) 안에서는 patch로 충분
  const patch = { summary: payload.title, colorId: colorId, extendedProperties: extendedProperties };
  if (payload.time) {
    patch.start = { dateTime: payload.date + 'T' + payload.time + ':00', timeZone: 'Asia/Seoul' };
    patch.end   = { dateTime: addOneHour_(payload.date, payload.time), timeZone: 'Asia/Seoul' };
  } else {
    patch.start = { date: payload.date };
    patch.end   = { date: payload.date };
  }
  const updated = Calendar.Events.patch(patch, CALENDAR_ID, payload.eventId);
  return { id: updated.id };
}

// ===== 삭제 =====
// deleteSeries: true면 반복 일정 전체 삭제, false/생략이면 이 날짜 건만 삭제
function deleteEvent(eventId, deleteSeries) {
  const ev = Calendar.Events.get(CALENDAR_ID, eventId);
  const isMaster = !!(ev.recurrence && ev.recurrence.length);   // 이 이벤트 자체가 반복 마스터인지
  const isInstance = !!ev.recurringEventId;                     // 반복 일정의 개별 발생건인지
  const targetId = (deleteSeries && isInstance) ? ev.recurringEventId : eventId;
  Calendar.Events.remove(CALENDAR_ID, targetId);
  return { deletedId: targetId, wasSeries: isMaster || (deleteSeries && isInstance) };
}

// ===== 대한민국 공휴일 (프론트 표시 전용 — 우리 팀 캘린더(CALENDAR_ID) 데이터와는 완전히 무관) =====
// 구글이 공개 제공하는 "대한민국의 휴일" 캘린더를 ICS로 그대로 받아와서 파싱함.
// 설날/추석/부처님오신날처럼 음력 기준이라 매년 손으로 넣기 번거로운 날짜까지 자동으로 맞음.
const KR_HOLIDAY_ICS_URL =
  'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';

function getKrHolidays() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('kr_holidays_v1');
  if (cached) return JSON.parse(cached);

  const ics = UrlFetchApp.fetch(KR_HOLIDAY_ICS_URL).getContentText();
  const result = parseKrHolidayIcs_(ics);

  try { cache.put('kr_holidays_v1', JSON.stringify(result), 21600); } catch (err) {} // 6시간(최대) 캐시 — 실패해도 무시하고 계속 진행
  return result;
}

// ICS의 각 VEVENT는 DTSTART;VALUE=DATE:YYYYMMDD + SUMMARY + DESCRIPTION 한 줄짜리라 파싱이 단순함
// (긴 줄 접힘(line folding)은 이 필드들엔 사실상 안 나와서 별도 처리 안 함).
// DESCRIPTION이 정확히 "공휴일"인 것만 실제 빨간날 — "기념일"(국군의날/어버이날 등)은 제외.
function parseKrHolidayIcs_(ics) {
  const lines = ics.split(/\r?\n/);
  const result = {};
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.date && cur.summary && cur.isHoliday) {
        result[cur.date] = result[cur.date] ? (result[cur.date] + ' / ' + cur.summary) : cur.summary;
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.indexOf('DTSTART;VALUE=DATE:') === 0) {
      const raw = line.split(':')[1].trim();
      cur.date = raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
    } else if (line.indexOf('SUMMARY:') === 0) {
      cur.summary = line.slice('SUMMARY:'.length).trim();
    } else if (line === 'DESCRIPTION:공휴일') {
      cur.isHoliday = true;
    }
  }
  return result;
}

// ===== 공유 태스크 (My Notes 공유 항목) — 구글 시트를 간단한 DB로 사용 =====
// 캘린더에 안 보이는 날짜(예: 아주 먼 옛날)에 이벤트로 숨겨서 DB처럼 쓰는 방법도 검토했었는데,
// 실제 사람이 보는 캘린더랑 같은 공간이라 실수로 지워질 위험이 있고(휴대폰 구독 등에서 우연히
// 보일 수도 있음), month 단위 조회 코드(listEvents)와 완전히 다른 조회 방식이 필요해서 코드량
// 이득도 없음 — 그래서 사람 눈에 안 띄는 별도 시트를 씀. 1단계 트리(부모 1개당 자식 여러 개,
// 자식의 자식은 없음)만 지원 — 프론트엔드 My Notes 구조와 동일하게 맞춤.
const TASKS_SHEET_NAME = 'SharedTasks';
// assignee 비어있으면 "모두에게 보냄"(전체 공개), 채워져 있으면 그 이름인 사람한테 보낸 태스크
// (+ 원래 만든 사람(owner)한테도 항상 보임 — 자기가 누구한테 보냈는지는 알아야 하니까)
// eventDate: 캘린더 일정의 "Send To"로 만들어진 복사본에만 채워짐(YYYY-MM-DD) — 프론트엔드가
// 이게 있으면 "OOO님이 보냄" 대신 그 날짜를 빨간 MM/DD 태그로 보여줌
const TASKS_HEADERS = ['id', 'text', 'done', 'parentId', 'order', 'owner', 'assignee', 'createdAt', 'updatedAt', 'eventDate'];

// 팀원 명단 — 최초 실행 때 이름 입력하면 여기 등록됨. "태스크 보내기" 드롭다운이 이 목록을 씀.
// 태스크 시트랑 같은 스프레드시트 안에 탭만 하나 더 쓰는 것(별도 파일 안 만듦)
const MEMBERS_SHEET_NAME = 'Members';
const MEMBERS_HEADERS = ['name', 'firstSeenAt', 'lastSeenAt'];

function getMembersSheet_() {
  const ss = SpreadsheetApp.openById(TASKS_SHEET_ID);
  let sheet = ss.getSheetByName(MEMBERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MEMBERS_SHEET_NAME);
    sheet.appendRow(MEMBERS_HEADERS);
  }
  return sheet;
}

function listMembers() {
  const sheet = getMembersSheet_();
  const values = sheet.getDataRange().getValues();
  return values.slice(1).filter(row => row[0]).map(row => row[0]);
}

// 이름이 이미 있으면 lastSeenAt만 갱신(멱등 — 매번 실행 때 불러도 안전), 없으면 새로 등록
function registerMember(name) {
  if (!name) throw new Error('이름이 없음');
  const sheet = getMembersSheet_();
  const values = sheet.getDataRange().getValues();
  const now = new Date().toISOString();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === name) {
      sheet.getRange(i + 1, 3).setValue(now);
      return { registered: false };
    }
  }
  sheet.appendRow([name, now, now]);
  return { registered: true };
}

// body: { oldName, newName } — 회원 관리(관리자 전용) 이름 변경. 이 사람이 이미 만들었거나
// 받은 태스크의 owner/assignee도 같이 바꿔줘야 옛 태스크가 고아(예전 이름을 가리킴)가 안 됨.
function renameMember(body) {
  const oldName = body.oldName, newName = (body.newName || '').trim();
  if (!oldName || !newName) throw new Error('이름이 비어있음');
  const sheet = getMembersSheet_();
  const values = sheet.getDataRange().getValues();
  let found = false;
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === oldName) {
      sheet.getRange(i + 1, 1).setValue(newName);
      found = true;
      break;
    }
  }
  if (!found) throw new Error('회원을 찾을 수 없음: ' + oldName);

  const taskSheet = getTasksSheet_();
  const tv = taskSheet.getDataRange().getValues();
  const headers = tv[0];
  const ownerColIdx = headers.indexOf('owner') + 1;
  const assigneeColIdx = headers.indexOf('assignee') + 1;
  for (let i = 1; i < tv.length; i++) {
    if (tv[i][ownerColIdx - 1] === oldName) taskSheet.getRange(i + 1, ownerColIdx).setValue(newName);
    if (tv[i][assigneeColIdx - 1] === oldName) taskSheet.getRange(i + 1, assigneeColIdx).setValue(newName);
  }
  return {};
}

// body: { name } — 명단에서만 제거. 이미 남긴 태스크는 기록으로 그대로 둠(굳이 안 지움)
function deleteMember(body) {
  const sheet = getMembersSheet_();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === body.name) { sheet.deleteRow(i + 1); return {}; }
  }
  return {}; // 이미 없으면 성공 취급(멱등)
}

// eventDate가 'YYYY-MM-DD' 같은 순수 날짜 문자열이면 시트가 "이건 날짜구나" 하고 멋대로
// 진짜 Date 셀로 바꿔버림(자동 인식) — 그러면 나중에 읽을 때 타임존 계산까지 끼어들어서 하루가
// 밀린 ISO 문자열로 돌아옴(실측: '2026-08-05'를 넣었는데 '2026-08-04T15:00:00.000Z'로 나옴).
// 값 넣기 전에 그 컬럼 서식을 "일반 텍스트(@)"로 미리 지정해두면 문자열 그대로 저장됨
function formatEventDateColumnAsText_(sheet) {
  const col = TASKS_HEADERS.indexOf('eventDate') + 1;
  sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
}

function getTasksSheet_() {
  const ss = SpreadsheetApp.openById(TASKS_SHEET_ID);
  let sheet = ss.getSheetByName(TASKS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TASKS_SHEET_NAME);
    sheet.appendRow(TASKS_HEADERS);
    formatEventDateColumnAsText_(sheet);
    return sheet;
  }
  // 컬럼(assignee 등)을 나중에 추가하면 이미 만들어진 시트의 1행(헤더)은 예전 그대로 남아서
  // 값이 밀리는 문제가 생김 — 매번 코드의 TASKS_HEADERS랑 실제 1행을 비교해서 다르면 자동으로
  // 고쳐줌(사람이 시트 열어서 직접 고칠 필요 없게)
  const currentHeaders = sheet.getRange(1, 1, 1, TASKS_HEADERS.length).getValues()[0];
  const matches = TASKS_HEADERS.every((h, i) => currentHeaders[i] === h);
  if (!matches) {
    sheet.getRange(1, 1, 1, TASKS_HEADERS.length).setValues([TASKS_HEADERS]);
    formatEventDateColumnAsText_(sheet); // 헤더가 방금 고쳐졌다 = eventDate 컬럼이 새로 생겼을 수 있는 시점
  }
  return sheet;
}

function rowToTask_(headers, row) {
  const task = {};
  headers.forEach((h, i) => { task[h] = row[i]; });
  task.done = task.done === true || task.done === 'TRUE';
  return task;
}

// id로 행을 찾음 — 클라이언트가 행 번호를 기억해뒀다가 보내는 방식은 동시에 여러 명이 쓰면
// 그 사이 행이 지워지거나 순서가 바뀌어서 엉뚱한 행을 건드릴 위험이 있음 — 그래서 요청마다
// 매번 id로 다시 찾음(행이 몇 개 안 되는 규모라 성능 문제 없음)
function findTaskRow_(sheet, id) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === id) return { rowIndex: i + 1, headers: values[0], row: values[i] };
  }
  return null;
}

function listTasks() {
  const sheet = getTasksSheet_();
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  return values.slice(1)
    .filter(row => row[0]) // id 없는 빈 행 제외
    .map(row => rowToTask_(headers, row));
}

function addTask(body) {
  const sheet = getTasksSheet_();
  const now = new Date().toISOString();
  const id = 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  sheet.appendRow([
    id,
    body.text || '',
    false,
    body.parentId || '',
    body.order || 0,
    body.owner || '',
    body.assignee || '', // 이 태스크를 보낸 사람 이름(직접 쓴 노트면 비어있음)
    now,
    now,
    '', // eventDate는 일단 비워서 넣고 바로 아래에서 텍스트 서식 지정 후 채움(자동 날짜 변환 방지)
  ]);
  if (body.eventDate) {
    const eventDateColIdx = TASKS_HEADERS.indexOf('eventDate') + 1;
    const lastRow = sheet.getLastRow();
    // 미리 컬럼 전체를 텍스트 서식으로 지정해도 appendRow가 빈 문자열을 넣은 뒤라 그런지 그대로
    // 날짜로 자동 변환되는 경우가 있었음(실측) — 그래서 이 셀 하나만 확실하게 텍스트로 지정하고
    // 그 다음에 값을 넣음(순서가 중요: 서식 먼저, 값은 그 다음)
    sheet.getRange(lastRow, eventDateColIdx).setNumberFormat('@').setValue(body.eventDate);
  }
  return { id: id };
}

function toggleTask(body) {
  const sheet = getTasksSheet_();
  const found = findTaskRow_(sheet, body.id);
  if (!found) throw new Error('태스크를 찾을 수 없음: ' + body.id);
  const doneColIdx = found.headers.indexOf('done') + 1;
  const updatedAtColIdx = found.headers.indexOf('updatedAt') + 1;
  const currentDone = found.row[doneColIdx - 1] === true || found.row[doneColIdx - 1] === 'TRUE';
  const nextDone = !currentDone;
  sheet.getRange(found.rowIndex, doneColIdx).setValue(nextDone);
  sheet.getRange(found.rowIndex, updatedAtColIdx).setValue(new Date().toISOString());
  return { done: nextDone };
}

function updateTaskText(body) {
  const sheet = getTasksSheet_();
  const found = findTaskRow_(sheet, body.id);
  if (!found) throw new Error('태스크를 찾을 수 없음: ' + body.id);
  const textColIdx = found.headers.indexOf('text') + 1;
  const updatedAtColIdx = found.headers.indexOf('updatedAt') + 1;
  sheet.getRange(found.rowIndex, textColIdx).setValue(body.text || '');
  sheet.getRange(found.rowIndex, updatedAtColIdx).setValue(new Date().toISOString());
  return {};
}

// body: { id, assignee } — 공유 대상 지정/변경. assignee가 빈 문자열이면 "전체"로 되돌림.
function assignTask(body) {
  const sheet = getTasksSheet_();
  const found = findTaskRow_(sheet, body.id);
  if (!found) throw new Error('태스크를 찾을 수 없음: ' + body.id);
  const assigneeColIdx = found.headers.indexOf('assignee') + 1;
  const updatedAtColIdx = found.headers.indexOf('updatedAt') + 1;
  sheet.getRange(found.rowIndex, assigneeColIdx).setValue(body.assignee || '');
  sheet.getRange(found.rowIndex, updatedAtColIdx).setValue(new Date().toISOString());
  return {};
}

// ===== 완료 후 삭제된 태스크 아카이빙 =====
// 규칙(사용자 지정): 완료 표시(done=true) 상태에서 지워지면 이 시트로 옮겨서 기록으로 남김.
// 완료 표시 없이 그냥 지워지면 아카이빙 없이 그대로 사라짐. 텍스트뿐이라 용량 걱정 없음 —
// 2차 가공(분석/정리)은 필요할 때 이 시트를 직접 열어서 하면 됨(여기선 그냥 쌓아두기만 함)
const ARCHIVE_SHEET_NAME = 'ArchivedTasks';
const ARCHIVE_HEADERS = TASKS_HEADERS.concat(['archivedAt']);

function getArchiveSheet_() {
  const ss = SpreadsheetApp.openById(TASKS_SHEET_ID);
  let sheet = ss.getSheetByName(ARCHIVE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ARCHIVE_SHEET_NAME);
    sheet.appendRow(ARCHIVE_HEADERS);
    return sheet;
  }
  const currentHeaders = sheet.getRange(1, 1, 1, ARCHIVE_HEADERS.length).getValues()[0];
  const matches = ARCHIVE_HEADERS.every((h, i) => currentHeaders[i] === h);
  if (!matches) sheet.getRange(1, 1, 1, ARCHIVE_HEADERS.length).setValues([ARCHIVE_HEADERS]);
  return sheet;
}

function archiveIfDone_(headers, row) {
  const doneColIdx = headers.indexOf('done');
  const isDone = row[doneColIdx] === true || row[doneColIdx] === 'TRUE';
  if (!isDone) return;
  const values = headers.map((h, i) => row[i]);
  getArchiveSheet_().appendRow(values.concat([new Date().toISOString()]));
}

function deleteTask(id) {
  const sheet = getTasksSheet_();
  const found = findTaskRow_(sheet, id);
  if (!found) return {}; // 이미 없으면 성공 취급(멱등 — 여러 명이 거의 동시에 지워도 에러 안 남)
  archiveIfDone_(found.headers, found.row);
  sheet.deleteRow(found.rowIndex);
  // 부모였다면 자식들도 같이 정리(1단계 트리라 자식의 자식은 없어서 한 번만 훑으면 됨) — 자식도
  // 각자 완료 여부에 따라 개별적으로 아카이빙됨(부모가 완료였어도 자식이 미완료면 자식은 그냥 사라짐)
  const parentColIdx = found.headers.indexOf('parentId');
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][parentColIdx] === id) {
      archiveIfDone_(found.headers, values[i]);
      sheet.deleteRow(i + 1);
    }
  }
  return {};
}

function reorderTask(body) {
  // body: { id, order } — 새 순서 값 하나만 저장. 여러 항목 순서를 한 번에 바꿔야 하면
  // 프론트엔드가 바뀐 것마다 이 액션을 순서대로 여러 번 호출함
  const sheet = getTasksSheet_();
  const found = findTaskRow_(sheet, body.id);
  if (!found) throw new Error('태스크를 찾을 수 없음: ' + body.id);
  const orderColIdx = found.headers.indexOf('order') + 1;
  sheet.getRange(found.rowIndex, orderColIdx).setValue(body.order);
  return {};
}

// ===== 배포 후 스스로 테스트용 (Apps Script 편집기에서 이 함수를 직접 실행해보면 됨) =====
function _selfTest() {
  const now = new Date();
  Logger.log(JSON.stringify(listEvents(now.getFullYear(), now.getMonth() + 1)));
}
function _selfTestTasks() {
  // TASKS_SHEET_ID를 채워넣은 뒤 이 함수를 실행해서 시트/CRUD가 제대로 도는지 확인
  const added = addTask({ text: '테스트 태스크', owner: '테스트' });
  Logger.log('added: ' + JSON.stringify(added));
  Logger.log('list: ' + JSON.stringify(listTasks()));
  Logger.log('toggle: ' + JSON.stringify(toggleTask({ id: added.id })));
  Logger.log('delete: ' + JSON.stringify(deleteTask(added.id)));
  Logger.log('list after delete: ' + JSON.stringify(listTasks()));
}
