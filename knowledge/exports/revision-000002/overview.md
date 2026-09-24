# Project overview revision 2

### App Server stdio 브리지 (`code.bridge`)

Status: `verified`. Kind: `component`.

config.codexExe로 codex app-server를 자식 프로세스로 띄우고 JSONL JSON-RPC를 중계한다. 한 줄 상한 16 MiB(MAX_LINE), 넘는 줄은 그 줄만 버리고 줄 앞의 id로 해당 요청만 tooLarge로 실패시키며 연결은 유지한다. 청크 합계로 끊기던 결함도 고쳐졌다. 연결이 끊기면 재연결하지 않는다.

Source: [bridge/app-server.mjs:12](../../../bridge/app-server.mjs#L12)

Evidence:

- bridge/app-server.mjs (FCC9EF14554B6061)
- 독립 리뷰 r2: id 대응·청크 경계 정상, 실제 27.6 MiB turn 재시도 흐름 확인

### 지식그래프 관리 도구 (`code.kg_tool`)

Status: `verified`. Kind: `component`.

WeatherAir 프로젝트의 scripts/knowledge.py를 2026-09-24 그대로 복사한 표준 라이브러리 전용 SQLite 지식그래프 도구(SHA256 FC5D6E50071AC8041DBF57DEDE0AAFB902EDE5E3239D335F80B71F12EF109923). init/status/check/search/show/apply(--expect-revision, --dry-run)/export를 제공하고 삭제 연산이 없다.

Source: [scripts/knowledge.py:335](../../../scripts/knowledge.py#L335)

Evidence:

- 원본 C:/Codex/Projects/WeatherAir/scripts/knowledge.py (WeatherAir에서도 미커밋 상태)
- scripts/knowledge.py 335행 apply_changes

### RemoteServer HTTP 서버 (`code.server`)

Status: `verified`. Kind: `component`.

로그인·세션·CSRF·Host/Origin 검사, 정적 파일, /api/* 라우팅, 작업 목록·열기·기록 페이지·시작·이어가기, turn 시작·중단·idempotency, 승인 중계, 업로드 API를 담당한다. 생성자 옵션 runtimeDir(운영 데이터 폴더)을 main()이 전달한다. 시작 시 App Server에 한 번 connect하고 실패하면 기동을 중단한다(재연결 없음).

Source: [server.mjs:200](../../../server.mjs#L200)

Evidence:

- server.mjs (후보 r4 AED584A11A85EA67)
- 독립 리뷰 review.20260924_desktop_r1~r3

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

public/app.js가 /api/tasks를 받아 위치(프로젝트명 또는 루트 기준 경로)·'다른 곳에서 사용 중'·'폴더 없음'·'보호됨 · 기록만' 표시와 잘림 원인 안내를 그린다. 기존 작업은 '이 작업 이어가기' 전까지 기록 보기 전용이며, 409 잠금·보호·폴더 없음은 일반 토스트 대신 대화 안 안내(잠금은 '다시 시도' 버튼)로 보여 준다. 브라우저 렌더링은 확인되지 않았다.

Source: [public/app.js:469](../../../public/app.js#L469)

Evidence:

- public/app.js (027DE06AA126137E) refreshTasks, renderTasks, addResumeNotice

### 첨부 저장소 UploadStore (`code.uploads`)

Status: `verified`. Kind: `component`.

소유 표식 폴더, 무작위 ID 파일명, 내용 서명 검사, 한도·보존·정리, manifest 원자적 교체를 구현한다. 세부 약속은 README '파일 첨부' 절.

Source: [lib/uploads.mjs:111](../../../lib/uploads.mjs#L111)

Evidence:

- lib/uploads.mjs 111행 이후
- README.md 36-115행

### README 제품 명세 (`doc.readme`)

Status: `verified`. Kind: `document`.

동작·보안 약속의 기준 문서. 2026-09-24 변경으로 '데스크톱에서 시작한 작업 이어가기' 절(resumeRoots 설정, 목록 정렬·상한, 보호 폴더, 인계 절차, 잠금 오류), '대화 기록' 절(5 turn 페이지, 과대 재시도, 자르기), 로그 정제·크기 상한이 추가되었다. '알려진 권한 문제'는 'App Server 제한' 아래 ### 절.

Source: [README.md:19](../../../README.md#L19)

Evidence:

- README.md (미커밋 후보 r4, SHA256 앞 16자리 FEB5C163D09AAFA7)

### 데스크톱 시작 작업의 웹 목록 표시와 이어가기 (`feature.desktop_resume`)

Status: `verified`. Kind: `feature`.

resumeRoots 하위에서 데스크톱 앱이 시작한 작업을 웹 목록에 최근 활동 순으로 보여 주고, 열어서 기록을 페이지로 보고, 데스크톱 앱이 잡고 있지 않으면 웹에서 이어간다. 데스크톱 앱이 잡은 작업은 409 안내(앱을 트레이까지 완전 종료 후 재시도). 폴더가 없는 작업과 보호 폴더와 겹치는 작업은 보기 전용. 웹이 이어간 작업은 웹 서버가 켜져 있는 동안 데스크톱에서 보기만 가능하므로 집에서 데스크톱으로 돌아갈 때는 stop.ps1 후 앱을 켠다.

Source: [server.mjs:398](../../../server.mjs#L398)

Evidence:

- README.md 데스크톱에서 시작한 작업 이어가기 절
- obs.listing_probe_20260924
- obs.deploy_20260924

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

첫 커밋 리뷰의 LOW 지적 현황(2026-09-24 후보 r4 기준). 해결: L9(/api/tasks 원본 전달 → 필드 축소, 열기 응답도 {thread:{id,name,status}}로 축소). 미해결: L2 터널 뒤 로그인 백오프 전역 버킷, L3 승인 카드 작업 표시 없음, L4 bridge #stderr 정제의 '$1' 치환 버그와 좁은 범위, L5 확실한 미전송도 409 uncertain, L6 전송용 첨부 선점 비영속, L7 itemContexts 무한 증가, L8 미사용 설정·코드, L10 테스트가 실행마다 증거 파일 생성, L11 start.ps1 URL 정규식 오인 가능. INFO: 본문 JSON null 500, Start-Process 인자 미인용, HSTS 없음, stop.ps1 예외 표시 등.

Evidence:

- 독립 리뷰 review.20260924 L2-L11·INFO
- 독립 리뷰 review.20260924_desktop_r3 참고 항목

### Codex Remote Web (`project.codexremoteweb`)

Status: `verified`. Kind: `project`.

개인 Windows PC에서 독립 codex app-server(stdio)를 띄워 127.0.0.1 웹 패널로 제어하고, Cloudflare Quick Tunnel로 외부(회사 PC 브라우저)에서 접속하는 도구. Node 20+ ESM, 외부 npm 의존성 없음. 2026-09-24 첫 커밋(3748874) 뒤 데스크톱 시작 작업의 목록 표시·웹 이어가기(resumeRoots), 기록 페이지 로딩, 잠금 안내, 운영 데이터 폴더 보호가 미커밋 작업 트리로 추가·배포되었다.

Source: [README.md:1](../../../README.md#L1)

Evidence:

- README.md
- server.mjs
- 세션 20260924 배포 기록 obs.deploy_20260924

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
- `project.codexremoteweb` — **contains** → `feature.desktop_resume`: 데스크톱 시작 작업 웹 표시·이어가기 기능
- `project.codexremoteweb` — **documented_in** → `doc.readme`: 동작·보안 약속의 기준 문서
- `project.codexremoteweb` — **pursues** → `goal.remote_continuity`: 제품의 실사용 목표
- `validation.20260923_rounds` — **historical_record_of** → `project.codexremoteweb`: 과거 개발 라운드 기록
