STATUS: FAIL
TASK: codexremote-ui-upload-independent-review-round2 — 고정 후보(round 2)의 UI 정리와 파일 업로드를 원래 요구사항과 round-1 지적에 비추어 읽기 전용으로 독립 리뷰
RESULT: 서버 쪽 보안 경계는 요구를 충족하며, 새 보안 결함은 찾지 못했습니다. round-1 지적은 대부분 해결되었습니다. 다만 L2(기록을 다시 불러올 때 첨부 안내 분리)는 실제 app-server 형식에서 여전히 실패할 가능성이 높습니다. 새 UI에도 LOW 결함이 몇 건 있어 FAIL로 판정합니다. 모두 국소 수정으로 고칠 수 있습니다.

**round-1 지적 해결 여부**
- **M1 해결**: 클립보드에 text/plain이 있으면 항상 기본 붙여넣기를 합니다 (ui-core.js:17-20, app.js:880-885). 단위 테스트가 있습니다.
- **L1 해결**: 모바일에서도 실행 관련 안내가 보입니다 (styles.css:289-290, app.js:331-332).
- **L2 부분 해결**: 아래 R1을 보십시오.
- **L3 해결**: Codex 안내문이 신뢰할 수 있는 파서나 ZIP 읽기 API로 읽기는 허용하고, 디스크에 풀어 놓는 것만 막습니다 (lib/uploads.mjs:355).
- **L4 완화**: 메타데이터 사전 확인이 추가되었습니다 (server.mjs:330-339). 이 확인은 아무것도 예약하지 않고, 실제 업로드가 모든 검사를 다시 합니다. 경합으로 연결이 끊기면 그 사실을 표시하고 1.5초 뒤 서버 목록을 다시 받습니다 (app.js:587-591, 465-471). 메인 수용 기준에 맞습니다.
- **L5 해결**: 선언 MIME은 참고용이고, 실행 가능한 콘텐츠를 선언한 경우만 거부합니다. 내용 서명 검사는 유지됩니다 (lib/uploads.mjs:29-31, 231-232).
- **L6 해결**: 썸네일은 로컬 blob을 쓰고, 칩이 사라지거나 실패하면 revoke합니다 (app.js:545, 473-478, 552). CSP는 `img-src 'self' blob:`만 추가했고, 나머지 지시어는 baseline과 같습니다 (server.mjs:127, baseline server.mjs:105).
- **L7 완화**: 응답을 받을 연결이 이미 없으면 서버가 저장한 파일을 지웁니다 (server.mjs:350-354). 취소한 뒤에는 목록을 다시 받아 숨은 첨부를 표시합니다.
- **L8 해결**: bridge가 JSON-RPC 오류에 rpcError 표시를 붙입니다 (bridge/app-server.mjs:106). 이 경우 422 확정 거부로 응답하고 첨부는 보내지 않은 상태로 돌아갑니다. 시간 초과 등은 409 불확실로 응답하고 첨부를 attempted로 표시하며, 화면에도 이 상태가 나옵니다 (server.mjs:289-303, lib/uploads.mjs:340-348, app.js:326, 485).
- **L9 해결**: README:87-92에 수동 회복 절차가 있고, 507 메시지에 사용량이 나옵니다.
- **L10 해결**: 소유 표식 방식으로 바뀌었습니다 (lib/uploads.mjs:151-162).
  - 표식이 없는데 비어 있지 않은 폴더는 아무것도 바꾸지 않고 거부합니다. 바이트 스냅샷 테스트로 확인합니다.
  - 비어 있는 기존 폴더는 표식을 만들어 사용합니다. README:75, 90의 회복 절차와 일치합니다.
- **L11 해결**: manifest 교체는 제한된 횟수만 재시도한 뒤 503으로 실패합니다. 정리 작업이 실패해도 시작이나 관계없는 업로드는 막지 않습니다 (lib/uploads.mjs:193-210, server.mjs:106-113).
- **L12 해결**: 기록 로딩 상태, 화면 밖 상태 알림, 스트리밍 응답의 제자리 갱신과 `aria-live=off`, 서랍의 inert 처리, 모바일 알림 상단 배치가 모두 들어갔습니다. 단 R2, R6, R7을 보십시오.
- **L13 해결**: 요청 시간을 10분으로 제한하고 문서에 적었습니다 (server.mjs:18, 84).
- **테스트 공백 해결**: 중단된 스트림 정리, DELETE의 CSRF/Origin 거부, 확정 거부와 불확실 구분 및 재전송, fixture 승인·질문·중단 시나리오, `npm run check` 범위가 추가되었습니다. 파일 symlink 사례는 이 호스트에서 여전히 EPERM으로 skip되며, README:123에 명시되어 있습니다.

**남은 결함**
- **R1 [LOW-MEDIUM · round-1 L2 잔여 · 실제 app-server로 확인하지 못함] 기록을 다시 불러오면 첨부 안내가 분리되지 않을 수 있음**
  - 원인:
    - splitNotice는 줄 맨 앞에 있는 머리글만 찾습니다 (ui-core.js:22, 37).
    - 서버 안내문은 앞에 줄바꿈 없이 `[Codex 원격 웹 첨부 파일 N개]`로 시작합니다 (lib/uploads.mjs:352).
    - 제가 아는 codex-rs 구현에서는 `UserMessageItem::message()`가 텍스트 입력을 구분자 없이(`join("")`) 이어 붙이고, thread/read 기록은 이 문자열로 다시 만들어집니다. 이 환경에서는 확인할 수 없습니다.
    - 그러면 첫 줄이 `첨부 요약해줘[Codex 원격 웹 첨부 파일 2개]`가 되어 머리글을 찾지 못합니다.
  - 영향:
    - 프롬프트와 첨부를 함께 보낸 메시지를 다시 열면, 사용자 말풍선에 안내문과 서버 절대 경로가 그대로 보입니다.
    - 기록에 localImage가 있으면 무작위 ID 이름의 칩으로 보입니다 (ui-core.js:61).
    - 작업 목록 제목을 `preview`에서 가져오면 머리글이 섞입니다 (app.js:262).
    - 첨부만 보낸 메시지는 영향이 없습니다.
  - 테스트가 잡지 못하는 이유: fake의 기록 병합이 `'\n\n'`으로 합칩니다 (test/fake-codex.mjs:53-55). fixture 기본값도 이 모드라서 (test/ui-fixture.mjs:39) 메인의 브라우저 확인에서도 드러나지 않습니다.
  - 제안:
    - 머리글을 줄 안 어디서든 찾고, 그 앞부분은 사용자 문장으로 넘기십시오. 이렇게 하면 이미 보낸 기록도 바르게 표시됩니다.
    - 필요하면 서버 안내문 앞에 `\n\n`을 붙이십시오.
    - fake 병합을 `join('')`으로 바꾸고, 이어 붙인 경우를 검사하는 테스트를 추가하십시오.
    - taskTitle에서 머리글 이후를 잘라 내십시오.
- **R2 [LOW · fixture로 재현 가능] 중단이나 오류 뒤에도 응답이 "작성 중"으로 남음**
  - 원인: 스트리밍 중에는 응답 노드에 is-streaming과 `aria-busy="true"`를 붙입니다 (app.js:704-713). 그런데 turn/completed 처리(app.js:742-747)는 이를 정리하지 않습니다.
  - 재현: fixture에서 `/fixture slow`를 보낸 뒤 "중단"을 누르십시오. fake는 turn/completed만 보냅니다 (test/fake-codex.mjs:155).
  - 영향:
    - 깜박이는 커서(styles.css:174)가 계속 남습니다. 첫 조각 전에 중단하면 "응답을 작성하는 중…"이 남습니다.
    - `aria-busy`가 남아 스크린리더가 그 응답을 건너뛸 수 있습니다.
    - turn 오류로 끝난 경우도 같습니다.
  - 제안: turn/completed와 연결 끊김 때 현재 작업의 스트리밍 노드를 완료 상태로 바꾸십시오.
- **R3 [LOW · baseline 대비 동작 변경] 작업을 고르면 입력 중인 초안이 경고 없이 사라짐**
  - 원인: 작업을 선택하거나 새로 만들 때 입력창을 비웁니다 (app.js:386, 867). baseline은 비우지 않았습니다 (baseline app.js:15).
  - 영향:
    - 첨부 트레이는 작업별로 유지되는데(app.js:420) 글만 버려져 일관성이 없습니다.
    - 모바일에서 서랍을 열고 현재 작업을 다시 눌러도 초안이 사라집니다.
  - 제안: 작업별로 초안을 보관해 복원하십시오. 최소한 같은 작업을 다시 누를 때는 유지하십시오.
- **R4 [LOW · 좁은 경합] 재시도에 대한 202(`dispatching`) 응답을 성공으로 처리함**
  - 조건:
    - 첫 전송에 대한 응답을 받지 못했습니다 (status 0).
    - 사용자가 같은 내용으로 다시 보냅니다. 이때 같은 requestId를 씁니다 (app.js:626-629).
    - 첫 turn/start가 아직 진행 중입니다 (최대 20초).
    - 서버는 202를 돌려줍니다 (server.mjs:264-269, 276).
  - 영향:
    - 클라이언트가 이를 성공으로 보고 트레이와 입력창을 비웁니다 (app.js:632-637).
    - 첫 전송이 결국 409(불확실)나 422(거부)로 끝나면 사용자는 알지 못합니다. 입력한 글은 사라지고, 첨부는 다음 동기화 전까지 보이지 않습니다.
    - 중복 turn은 생기지 않습니다.
  - 제안: 202를 받으면 입력, 트레이, requestId를 유지하고 "전송 확인 중"으로 표시하십시오. 잠시 뒤 같은 requestId로 다시 요청해 최종 결과(200/409/422)를 받으십시오.
- **R5 [LOW · 화면 상태가 서버 상태와 다름] 첨부 설정을 한 번만 불러옴**
  - 원인: loadUploadConfig는 로그인 직후에만 호출됩니다 (app.js:794). 일시적 오류가 나도 "이 서버에서는 파일 첨부를 사용할 수 없습니다"로 표시합니다 (app.js:434, 439). 새로고침 버튼(app.js:840-844)은 이 설정을 다시 불러오지 않습니다.
  - 영향: 다시 로그인하기 전까지 첨부가 막히고, 원인도 틀리게 안내됩니다.
  - 제안: 요청 실패와 서버의 `enabled:false`를 구분하고, 새로고침이나 다음 폴링 때 다시 시도하십시오.
- **R6 [LOW · 접근성 · baseline부터 있던 동작] 작업을 고르면 키보드 포커스가 사라짐**
  - 원인: 작업을 선택하면 목록 전체를 다시 그립니다 (app.js:387, 283). 방금 누른 버튼이 교체되어 포커스가 body로 갑니다.
  - 제안: 다시 그린 뒤 선택된 작업 버튼이나 입력창으로 포커스를 옮기십시오.
- **R7 [LOW · 좁은 경합] 새 작업 화면에 "기록을 불러오는 중…"이 남음**
  - 조건: 기존 작업의 기록(thread/read)을 불러오는 도중에 새 작업을 만듭니다.
  - 원인: 이전 선택 처리가 로딩 표시(`loadingThread`)를 지우지 않고 끝납니다 (app.js:391). 새 작업 경로(app.js:866-868)도 이를 초기화하지 않습니다.
  - 영향: 빈 새 작업에 로딩 문구가 남습니다. `#feed`의 `aria-busy="true"`(app.js:160)는 메시지를 보낸 뒤에도 남습니다.
  - 제안: 새 작업을 만들 때 `state.loadingThread = null`로 초기화하십시오.

**참고 (결함 아님)**
- 한국어 Windows Excel의 "CSV (쉼표로 분리)"는 CP949로 저장됩니다. 그래서 엄격한 UTF-8 검사(lib/uploads.mjs:255-269)에서 거부됩니다. 검사는 유지하되, 오류 메시지에 "Excel에서는 'CSV UTF-8'로 저장하세요"를 덧붙이기를 권합니다.
- README:61, 70은 10분 `requestTimeout`을 uploadLimits 표에 넣었지만, 실제로는 코드에 고정된 값입니다 (server.mjs:18).
- UPLOAD_TYPES의 declared 목록(lib/uploads.mjs:17-26)은 더 이상 쓰이지 않습니다.
- work-artifacts/readme-round1-tail.tmp.md는 engineer가 남긴 자리표시 파일입니다. 삭제 여부는 사용자가 판단할 일입니다.

**새 보안·회귀 확인 (문제 없음)**
- **turn 첨부 처리 순서**: 기존 결과 확인(replay) → 세션·작업·프로젝트 소유권 확인 → replay 재확인 → 동기 claim → 202 기록 순서입니다. 같은 요청 ID의 동시 요청과 다른 요청 ID의 경합 모두 한 번만 전송됩니다 (server.mjs:263-276, lib/uploads.mjs:318-337).
- **파일 이름**: 제어 문자와 bidi 문자를 제거한 뒤 표시용으로만 씁니다. 안내문에 줄을 끼워 넣을 수 없습니다.
- **저장·삭제**: 파일은 `wx+`로 만들고, 매번 files 폴더의 실제 경로를 다시 확인합니다. 삭제는 lstat 결과 일반 파일일 때만 합니다.
- **기존 remote 테스트 11개**: 해시가 round 1과 같습니다. uploadDir가 없으면 업로드 기능이 꺼지므로 기존 경로는 그대로입니다. 첨부 없는 turn의 JSON-RPC 오류가 409에서 422로 바뀐 것은 의도된 변경입니다.
- **기존 흐름**: 로그인, 작업 목록·생성·이어가기, 모델·추론 수준 선택, 전송, 중단, 승인 흐름이 보존된 것을 코드로 확인했습니다.
- **fixture 전용 기능**: `/fixture …` 시나리오는 test/에만 있습니다. 제품 UI의 첨부 버튼은 서버 설정과 작업 제어 상태에 묶여 있습니다 (R5 예외).
- **알려진 권한 문제**: danger-full-access 문제는 README:23-25와 index.html:120에서 숨기지 않고 알립니다.

RUN: 허용된 명령 세 개만 실행했습니다: Get-ChildItem, `git status --short`(전부 untracked), Get-FileHash. 테스트, `node --check`, 브라우저, 실제 Codex는 실행하지 않았고, 파일도 쓰지 않았습니다. run-dir: C:\Codex\Scratch\claude-code-worker\runs\1790167650852-27472-46180786-4a66-4a2b-a560-d20e765c932d
EVIDENCE:
- 해시 7개가 candidate-round2-hashes.json과 일치합니다: server.mjs B53A79A4…, lib/uploads.mjs 92B3CA66…, bridge/app-server.mjs D22779F1…, public/app.js 0FADAC9B…, public/ui-core.js 6375832E…, public/index.html C7460A1B…, public/styles.css 242AABC4….
- 읽은 파일: 위 7개, test/* 6개, README, package.json, config.example.json, setup.mjs, start.ps1, stop.ps1, .gitignore, review-round1.md, baseline/*.
- 실행 증거: work-artifacts/test-evidence/round1-validation-raw.txt (35개 중 34 통과, 1 skip — 파일 symlink EPERM).
- 실행 증거: uploads-2026-09-23T12-45-28-355Z-14828.json.
- 실행 증거: round2-extra-syntax.txt (ui-core `--check` exit 0).
CHANGES: 없음 (읽기 전용).
LIMITS:
- 테스트를 다시 실행하지 않았습니다. raw 로그에 해시가 없어, 현재 후보와의 연결은 테스트 이름과 순서가 현재 파일과 같다는 점으로만 확인했습니다.
- README, config.example.json, package.json, setup.mjs, start.ps1, stop.ps1, .gitignore, icon.svg, test/*의 해시는 허용 명령으로 계산하지 못했습니다. 내용은 읽었습니다.
- R1과 R2의 실제 app-server 동작은 확인하지 못했습니다. 확인할 항목은 기록 병합 구분자와, 중단 시 부분 메시지의 item/completed 전송 여부입니다. R1은 두 형식 모두에서 동작하도록 고치면 실제 확인이 필요 없습니다.
- 여전히 확인하지 못한 항목:
  - Cloudflare Tunnel을 거쳐도 Content-Length가 유지되는지 (유지되지 않으면 모든 업로드가 411로 거부됨)
  - Windows 파일 symlink 사례
  - 390px 화면과 실제 브라우저 동작 (메인이 별도로 확인 예정)
- 알려진 danger-full-access 문제는 이번 범위 밖이며 그대로 남아 있습니다.