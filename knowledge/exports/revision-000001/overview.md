# Project overview revision 1

### App Server stdio 브리지 (`code.bridge`)

Status: `verified`. Kind: `component`.

config.codexExe로 'codex app-server'(transport=proxy면 'app-server proxy')를 자식 프로세스로 띄우고 JSONL JSON-RPC를 중계한다. CODEX_HOME·USERPROFILE을 config로 지정한다. 연결이 끊기면 status 이벤트만 내고 재연결하지 않는다.

Source: [bridge/app-server.mjs:7](../../../bridge/app-server.mjs#L7)

Evidence:

- bridge/app-server.mjs 22-39행 connect
- bridge/app-server.mjs 137-153행 disconnect
- server.mjs에 reconnect 코드 없음 (grep 2026-09-24)

### 지식그래프 관리 도구 (`code.kg_tool`)

Status: `verified`. Kind: `component`.

WeatherAir 프로젝트의 scripts/knowledge.py를 2026-09-24 그대로 복사한 표준 라이브러리 전용 SQLite 지식그래프 도구(SHA256 FC5D6E50071AC8041DBF57DEDE0AAFB902EDE5E3239D335F80B71F12EF109923). init/status/check/search/show/apply(--expect-revision, --dry-run)/export를 제공하고 삭제 연산이 없다.

Source: [scripts/knowledge.py:335](../../../scripts/knowledge.py#L335)

Evidence:

- 원본 C:/Codex/Projects/WeatherAir/scripts/knowledge.py (WeatherAir에서도 미커밋 상태)
- scripts/knowledge.py 335행 apply_changes

### RemoteServer HTTP 서버 (`code.server`)

Status: `verified`. Kind: `component`.

로그인·세션·CSRF·Host/Origin 검사, 정적 파일, /api/* 라우팅, 작업 목록·읽기·시작·이어가기, turn 시작·중단·idempotency, 승인 중계, 업로드 API를 담당한다. 시작 시 App Server에 한 번 connect하고 실패하면 기동을 중단한다.

Source: [server.mjs:51](../../../server.mjs#L51)

Evidence:

- server.mjs 51-104행 (constructor, start)
- server.mjs 181-207행 api 라우팅

### 초기 설정 setup.mjs (`code.setup`)

Status: `verified`. Kind: `component`.

무작위 접근 비밀번호의 scrypt 해시와 세션 키를 저장소 밖 data 폴더의 runtime-config.json에 쓰고 ACL을 잠근다. 비밀번호 원문은 별도 출력 파일에만 둔다.

Source: [setup.mjs:13](../../../setup.mjs#L13)

Evidence:

- setup.mjs 13행 secure
- README.md 8행

### 기동 스크립트 start.ps1 (`code.start_script`)

Status: `verified`. Kind: `component`.

cloudflared Quick Tunnel을 먼저 띄워 URL을 받고 publicOrigin을 config에 기록한 뒤 Node 서버를 시작하고 /health와 127.0.0.1 리스너 소유를 확인한다. owned-processes.json에 PID·시작 시각·경로를 남긴다.

Source: [start.ps1:36](../../../start.ps1#L36)

Evidence:

- start.ps1 36-63행

### 종료 스크립트 stop.ps1 (`code.stop_script`)

Status: `verified`. Kind: `component`.

owned-processes.json의 PID·시작 시각·경로가 모두 맞을 때만 서버와 터널을 종료한다. 기록 파일은 지우지 않는다.

Source: [stop.ps1:12](../../../stop.ps1#L12)

Evidence:

- stop.ps1 6-15행

### UI 공통 로직 ui-core (`code.ui.core`)

Status: `verified`. Kind: `component`.

첨부 안내문 분리(splitNotice), 붙여넣기 정책, 제목 추출 등 화면 공통 순수 함수.

Source: [public/ui-core.js:56](../../../public/ui-core.js#L56)

Evidence:

- public/ui-core.js 56행 splitNotice

### 결과 모름 전송 관리 DispatchBook (`code.ui.dispatch`)

Status: `verified`. Kind: `component`.

작업별 전송 기록을 고정해 결과 불확실(409/202/네트워크) 시 같은 본문으로만 재확인하고 9분 뒤 포기만 허용한다. 화면과 테스트가 같은 모듈을 쓴다.

Source: [public/dispatch-state.js:62](../../../public/dispatch-state.js#L62)

Evidence:

- public/dispatch-state.js 7-10행 상수, 62행 DispatchBook
- README.md 61-69행

### 웹 UI 작업 목록·이어가기 (`code.ui.tasks`)

Status: `verified`. Kind: `component`.

public/app.js가 /api/tasks를 받아 목록을 그리고, 기존 작업은 '이 작업 이어가기' 전까지 기록 보기 전용이며 이어가기에서 /api/tasks/resume을 호출한다.

Source: [public/app.js:408](../../../public/app.js#L408)

Evidence:

- public/app.js 279행 renderTasks, 408행 refreshTasks, 447행 tasks/resume 호출

### 첨부 저장소 UploadStore (`code.uploads`)

Status: `verified`. Kind: `component`.

소유 표식 폴더, 무작위 ID 파일명, 내용 서명 검사, 한도·보존·정리, manifest 원자적 교체를 구현한다. 세부 약속은 README '파일 첨부' 절.

Source: [lib/uploads.mjs:111](../../../lib/uploads.mjs#L111)

Evidence:

- lib/uploads.mjs 111행 이후
- README.md 36-115행

### README 제품 명세 (`doc.readme`)

Status: `verified`. Kind: `document`.

동작·보안 약속의 기준 문서. 준비·보안 경계·App Server 제한·알려진 권한 문제·화면·파일 첨부·로컬 UI fixture·검사 절을 가진다. 'App Server 제한' 절은 활성 또는 다른 writer가 점유한 작업을 resume하지 않는다고 적는다.

Source: [README.md:19](../../../README.md#L19)

Evidence:

- README.md 전체 1-145행 (2026-09-24 읽음)

### 집 데스크톱 앱과 외부 웹에서 같은 작업 이어가기 (`goal.remote_continuity`)

Status: `documented`. Kind: `goal`.

사용자 실사용 목표. 2026-09-24 사용자 원문: '코덱스 리모트 웹 관련해서 세션이 달라서 그런지 온라인에서는 집에서 한 작업 확인도 안되고 웹에서 한 작업은 집에서 확인은 되지만 작업을 이어서 하는것도 안되는 것 같은데 어떻게 해야해?' 이 문제 제기에서 도출한 목표이며, 해결 방식(공식 원격 제어 vs 웹 패널 인계)은 아직 사용자가 정하지 않았다.

Evidence:

- 세션 20260924 대화 첫 사용자 요청 원문

### 전역 danger-full-access 상속 (`issue.full_access`)

Status: `verified`. Kind: `issue`.

웹 패널의 app-server는 사용자 전역 Codex 설정을 상속한다. 2026-09-24 전역 config.toml의 sandbox_mode는 danger-full-access였다. 웹에서도 선택 프로젝트 밖을 포함한 PC 전체 파일 읽기·쓰기·명령 실행이 가능하며 패널은 이를 막지 않는다.

Evidence:

- README.md 23-25행 알려진 권한 문제
- C:/Users/glalm/.codex/config.toml 5행 sandbox_mode (2026-09-24 grep, 값 외 내용은 기록하지 않음)

### 2026-09-24 리뷰 LOW·INFO 묶음 (`issue.review_low_20260924`)

Status: `verified`. Kind: `issue`.

LOW 지적 묶음. L2 터널 뒤에서는 remoteAddress가 항상 127.0.0.1이라 로그인 백오프가 전역 한 버킷(가용성 문제). L3 승인 카드에 작업 표시 없음, diff만 온 파일 변경은 diff 미표시. L4 stderr 정제가 비캡처 그룹에 '$1'을 써 '$1=[redacted]'가 그대로 들어가고 Bearer·API_KEY는 정제하지 않으며 이 문자열이 /api/state로 나간다(인증 사용자만). L5 확실한 미전송('App Server is unavailable')도 409 uncertain으로 분류되어 첨부가 attempted로 14일 보존. L6 전송용 첨부 선점(claim)이 영속되지 않아 전송 중 서버가 죽으면 재시작 정리가 참조됐을 수 있는 파일을 지울 수 있음. L7 itemContexts 무한 증가. L8 미사용 설정·코드(.env.example 변수, setup의 sessionKey, allowedProjects, declared 목록). L9 /api/tasks가 thread 원본(잘리지 않은 미리보기·로컬 경로)을 그대로 전달. L10 테스트가 실행마다 work-artifacts/test-evidence에 파일 생성. L11 start.ps1 URL 정규식이 cloudflared 오류 줄의 api.trycloudflare.com을 오인할 수 있고 공개 URL 도달 확인이 없음. INFO: 본문 JSON null·잘못된 % 인코딩 ID에 500, resume 시 controlledThreads가 프로젝트 기록보다 먼저 추가, 날짜 채팅 폴더 경로 하드코딩(setup.mjs 10행, start.ps1 10행), Start-Process 인자 미인용으로 공백 경로 실패, HSTS 없음, stop.ps1이 모든 예외를 already absent로 표시.

Evidence:

- 독립 리뷰 L2-L11·INFO 항목의 파일:줄 (server.mjs 158-171행, bridge/app-server.mjs 155-159행, server.mjs 293-303행, lib/uploads.mjs 334-337행, server.mjs 75행·476-478행, start.ps1 41-42행 등)
- reviewer sanitizer-check 출력 'error: $1=[redacted] $1=[redacted] Authorization: Bearer ...'

### Codex Remote Web (`project.codexremoteweb`)

Status: `verified`. Kind: `project`.

개인 Windows PC에서 독립 codex app-server(stdio)를 띄워 127.0.0.1 웹 패널로 제어하고, Cloudflare Quick Tunnel로 외부에서 접속하는 실험용 도구. Node 20+ ESM, 외부 npm 의존성 없음. 2026-09-24 첫 커밋 전 작업 트리 기준으로 소스·README·테스트를 확인했다.

Source: [README.md:1](../../../README.md#L1)

Evidence:

- README.md 1-21행
- package.json (type=module, 의존성 없음)
- server.mjs, bridge/app-server.mjs, lib/uploads.mjs, public/*

### 2026-09-23 개발 리뷰·검증 라운드 기록 (`validation.20260923_rounds`)

Status: `historical`. Kind: `validation`.

첨부·전송 상태 기능 개발 중 리뷰 1·2차와 최종 리뷰, 라운드별 검증 로그와 후보 해시가 work-artifacts에 남아 있다. 과거 시점 기록이며 현재 통과를 뜻하지 않는다.

Evidence:

- work-artifacts/review-input/review-round1.md, review-round2.md, review-final-findings.md
- work-artifacts/test-evidence/round1-validation-raw.txt, round2-validation-raw.txt, dispatch-fix-validation-raw.txt

## Project links

- `issue.full_access` — **affects** → `project.codexremoteweb`: 웹에서도 PC 전체 접근 가능
- `issue.review_low_20260924` — **affects** → `project.codexremoteweb`: LOW·INFO 결함 묶음
- `project.codexremoteweb` — **contains** → `code.bridge`: App Server 브리지
- `project.codexremoteweb` — **contains** → `code.kg_tool`: 지식그래프 관리 도구
- `project.codexremoteweb` — **contains** → `code.server`: HTTP 서버 본체
- `project.codexremoteweb` — **contains** → `code.setup`: 초기 설정
- `project.codexremoteweb` — **contains** → `code.start_script`: 기동 스크립트
- `project.codexremoteweb` — **contains** → `code.stop_script`: 종료 스크립트
- `project.codexremoteweb` — **contains** → `code.ui.core`: UI 공통 로직
- `project.codexremoteweb` — **contains** → `code.ui.dispatch`: 전송 상태 모듈
- `project.codexremoteweb` — **contains** → `code.ui.tasks`: 웹 UI
- `project.codexremoteweb` — **contains** → `code.uploads`: 첨부 저장소
- `project.codexremoteweb` — **documented_in** → `doc.readme`: 동작·보안 약속의 기준 문서
- `project.codexremoteweb` — **pursues** → `goal.remote_continuity`: 제품의 실사용 목표
- `validation.20260923_rounds` — **historical_record_of** → `project.codexremoteweb`: 과거 개발 라운드 기록
