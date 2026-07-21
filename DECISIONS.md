# TKM Widget — 결정된 사항 (Q1.md 답변 반영, 2026-07-21)

## 확정
| 항목 | 값 |
|---|---|
| 공유 캘린더 ID | `4b9c15c5a0e715482c08ecf5b10482391754fd997bb4fe7d5b3615cb5991b31c@group.calendar.google.com` |
| 카테고리(순서 확정) | 자료, 미팅, 교육, 내방, 행사, 기타 |
| 시간 입력 | 선택 필드. 비워두면 하루종일, 입력하면 해당 시각+1시간짜리 일정(종료시각 UI는 아직 없음) |
| GitHub 저장소 | `hgpark27-alt/thegoodgame` 재사용 — 기존 app.js/index.html/style.css는 4단계(프론트엔드)에서 교체 예정, Firebase 연결은 유지(당장 미사용, 필요 시 보조 저장소로 재검토) |
| 앱 이름 | TKM 캘린더 |
| 반복 종료 기본값 | 1년 (무기한 금지) |
| 수정 권한 | 등록자 이름 기반 소프트 체크(로그인 없어서 강제는 불가, 실수 방지 목적) |

## 카테고리 → colorId 매핑 (확정)
표시 순서 = Code.gs `CATEGORY_COLORS` 객체의 키 순서 그대로 프론트엔드 칩에 반영됨.

| 순서 | 카테고리 | colorId | 색 이름 |
|---|---|---|---|
| 1 | 자료 | 5 | Banana (노랑) |
| 2 | 미팅 | 9 | Blueberry (파랑) |
| 3 | 교육 | 3 | Grape (보라) |
| 4 | 내방 | 10 | Basil (초록) |
| 5 | 행사 | 11 | Tomato (빨강) |
| 6 | 기타 | 8 | Graphite (회색, 미매핑 기본값과 동일) |

남은 3개(1,2,4,6,7 중 미사용분)는 카테고리 추가될 때마다 순서대로 배정.

## Apps Script 배포 계정
Q2 "몰라 알아서 해"에 대한 답 — 원칙은 **캘린더 ID를 소유했거나 편집 권한이 있는 Google 계정**으로 script.google.com에 로그인해서 배포해야 함(Apps Script 웹앱은 "실행 = 나(배포자)" 권한으로 캘린더에 접근하기 때문). 어느 계정으로 저 캘린더를 만들었는지 본인이 제일 잘 아실 거라, SETUP.md 1번 단계에서 그 계정으로 로그인하고 진행하시면 됩니다. 헷갈리면 캘린더 앱에서 해당 캘린더 → 설정 → "특정 사용자와 공유"에 본인 계정이 "변경 및 공유 관리 권한"으로 있는지 확인하시면 됩니다.

## 반복 일정 방식 (Q6, 웹 검색 확인)
Google Calendar API가 iCalendar 표준 RRULE을 네이티브 지원 — 앱이 직접 반복 일정을 여러 건 만들 필요 없이 **RRULE 문자열 하나만 넘기면 구글이 알아서 반복 처리**함.
- 매주: `RRULE:FREQ=WEEKLY;UNTIL=...`
- 격주 특정요일: `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;UNTIL=...`
- N일마다: `RRULE:FREQ=DAILY;INTERVAL=N;UNTIL=...`
- UNTIL 기본값 = 시작일 + 1년 (사용자가 안 정하면)

삭제 시 "이 일정만 삭제"와 "반복 전체 삭제"를 명확히 구분 가능(`recurringEventId`로 마스터 이벤트를 찾아 지우면 전체 삭제, 개별 인스턴스 ID로 지우면 그 날짜만 삭제) — Google이 공식 지원하는 방식이라 "몇만년 후까지 안 지워지는" 문제 없음.

Sources:
- [Recurring events | Google Calendar API](https://developers.google.com/workspace/calendar/api/guides/recurringevents)
- [Class RecurrenceRule | Apps Script](https://developers.google.com/apps-script/reference/calendar/recurrence-rule)
