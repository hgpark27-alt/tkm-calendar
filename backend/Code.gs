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

// ===== 배포 후 스스로 테스트용 (Apps Script 편집기에서 이 함수를 직접 실행해보면 됨) =====
function _selfTest() {
  const now = new Date();
  Logger.log(JSON.stringify(listEvents(now.getFullYear(), now.getMonth() + 1)));
}
