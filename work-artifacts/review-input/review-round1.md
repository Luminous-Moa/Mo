STATUS: FAIL
TASK: codexremote-ui-upload-independent-review — 고정 후보(UI 전면 정리와 파일 업로드)를 원래 요구와 비교한 독립 읽기 전용 리뷰
RESULT: 서버 쪽 업로드 보안 경계는 요구를 충족하며, HIGH 수준 보안 결함은 찾지 못했습니다. 다만 기존 텍스트 붙여넣기 흐름의 MEDIUM 회귀 1건, LOW 수준 사용성·견고성 문제 여러 건, 테스트 공백이 있어 FAIL로 판정합니다. 모두 국소 수정으로 고칠 수 있습니다.

**코드로 확인한 충족 사항**
- 업로드는 로그인, 정확한 Origin, CSRF 확인 뒤에만 처리됩니다 (server.mjs:131-135, 173).
- Content-Length가 필수이며, 파일·개수·합계·저장소 한도는 본문을 읽기 전에 검사합니다. 설정으로는 한도를 낮출 수만 있습니다 (server.mjs:305-306, lib/uploads.mjs:34, 110-117, 198-204).
- 저장 이름은 서버가 만든 무작위 ID이고, 표시 이름과 분리됩니다. 파일은 `wx+`(기존 파일이 있으면 실패)로 만들고, realpath·junction 검사를 거칩니다 (lib/uploads.mjs:141-147, 208-213, 232, 256-265).
- 첨부는 세션·작업·프로젝트에 묶입니다 (lib/uploads.mjs:251-254, 278-291).
- 첨부 선점(claim)은 동기로 처리되고, idempotency digest에 첨부 ID 목록이 포함됩니다 (server.mjs:248-260).
- 업로드만으로는 Codex turn이 시작되지 않습니다.
- 미리보기는 이미지에만 제공되고 nosniff와 CSP sandbox가 붙습니다 (server.mjs:324-336).
- 정리 작업은 인덱스(manifest)에 있는 파일만 지웁니다 (lib/uploads.mjs:321-360).
- 알려진 danger-full-access 문제를 README:23-25와 index.html:119에서 숨기지 않고 알립니다.

**결함 / 위험**
- **[M1] 붙여넣기가 텍스트를 가로챔 (baseline 대비 회귀)** — public/app.js:808-811
  - 조건: 클립보드에 텍스트와 이미지가 함께 있을 때(예: Excel 셀 범위 복사). Chromium 계열 브라우저는 클립보드 이미지를 파일(`clipboardData.files`)로 넘기는 것으로 알려져 있습니다.
  - 영향: 기본 붙여넣기를 막고 image.png를 업로드합니다. 텍스트는 들어가지 않습니다. 업로드를 끈 서버에서는 오류 알림만 뜨고 텍스트도 들어가지 않습니다.
  - 제안: 클립보드에 text/plain이 있으면 기본 붙여넣기를 유지하고, 파일만 있을 때만 첨부하십시오.
- **[L1] 모바일에서 안내 문구가 숨겨짐** — styles.css:285가 760px 이하에서 `#composer-hint`를 숨깁니다. 그래서 app.js:342-346의 "첨부만 보내기" 안내와 보낼 수 없는 이유가 390px에서 보이지 않습니다.
- **[L2] 기록을 다시 불러올 때 첨부 칩 표시가 취약함** — app.js:191-209는 텍스트 파트가 알림 제목으로 시작할 때만 칩으로 바꿉니다. 실제 app-server가 기록에서 prompt와 알림을 한 파트로 합쳐 돌려주면, 사용자 말풍선에 서버 절대 경로와 경고문이 그대로 보입니다. fake는 파트를 분리해서 돌려주므로 테스트에서 드러나지 않습니다.
- **[L3] Codex 안내문이 DOCX/XLSX 읽기와 충돌할 수 있음** — lib/uploads.mjs:312의 "압축을 풀거나 … 하지 마세요"는 ZIP 형식인 DOCX/XLSX를 읽는 일과 겹칩니다. 모델이 문서 파싱을 거부할 수 있으며, 실제 모델로만 확인할 수 있습니다.
- **[L4] 조기 거부 응답이 연결 오류로 보일 수 있음** — 409(작업 미제어)/411/413/415(MIME 불일치)/507은 본문을 읽기 전에 `Connection: close`로 응답합니다 (server.mjs:300-316, lib/uploads.mjs:192-203). 브라우저가 아직 본문을 보내는 중이면 응답 대신 네트워크 오류로 끝나고, 화면에는 app.js:548의 "업로드 중 연결이 끊겼습니다"만 나올 수 있습니다. 507(저장소 가득)은 클라이언트 사전 검사도 없어 사용자가 원인을 알기 어렵습니다.
- **[L5] 선언 MIME 허용 목록이 정상 파일을 거부할 수 있음** — lib/uploads.mjs:196-197은 플랫폼마다 다른 MIME 문자열(예: CSV 변형)을 415로 거부할 수 있고, 이 거부도 [L4] 경로를 탑니다.
- **[L6] 썸네일이 원본을 다시 내려받음** — app.js:478-481은 방금 올린 이미지의 썸네일을 서버 원본(최대 20 MiB)으로 불러옵니다. 모바일 데이터가 두 배로 듭니다. 새로 올린 파일은 로컬 object URL을 쓰는 편이 낫습니다.
- **[L7] 업로드 취소와 완료가 겹치는 경우** — 서버가 저장을 끝낸 직후 사용자가 취소하면 클라이언트는 항목을 지웁니다 (app.js:549). 서버에는 staged 첨부가 남아 5개/50 MiB 한도에 계산되고, 다음 동기화 전까지 화면에 보이지 않습니다.
- **[L8] 확정된 거부도 "결과 불확실"로 처리함** — server.mjs:274-280은 turn/start의 JSON-RPC 오류(예: 모델이 이미지 입력을 지원하지 않음)도 409 "결과 불확실"로 응답하고 첨부를 attempted로 표시합니다. 이 첨부는 제거해도 14일 보관되고, 안내 문구가 사실과 다릅니다. 클라이언트는 attempted 상태를 표시하지 않습니다 (app.js:437-439).
- **[L9] 저장소가 가득 차면 앱 안에서 회복할 수 없음** — 제어 중인 작업의 보낸 첨부는 만료되지 않고 (lib/uploads.mjs:343-345), 보낸 첨부는 삭제할 수 없습니다 (lib/uploads.mjs:270). 장기 실행 중 1 GiB에 도달하면 507이 계속됩니다. 회복하려면 설정 변경과 재시작이 필요하며 README에 절차가 없습니다.
- **[L10] uploadDir를 전용 폴더로 가정함** — 설정 오류로 기존 폴더를 지정하면 그 안의 사용자 manifest.json을 이름 변경하거나 덮어씁니다 (lib/uploads.mjs:135, 151-156, 170-179). 기본 경로에서는 해당하지 않습니다.
- **[L11] Windows에서 manifest 교체 실패에 약함 (미검증)** — rename에 재시도가 없습니다. 백신 등이 파일을 잡고 있어 EPERM이 나면, 정리 작업의 저장 실패 때문에 관계없는 업로드가 500으로 실패하고 (server.mjs:308), 시작 시 정리(server.mjs:93)에서 실패하면 서버가 시작되지 않습니다.
- **[L12] 로딩 상태와 접근성**
  - 작업 기록을 불러오는 동안 "아직 대화가 없습니다" 빈 화면이 보입니다 (app.js:161-167, 401).
  - 업로드 성공·오류가 스크린리더에 알려지지 않습니다.
  - 스트리밍 응답 노드를 매 폴링마다 교체해서 (app.js:175-182) `role=log` 영역(index.html:84)에서 반복해서 읽힐 수 있습니다.
  - 모바일 서랍이 열려 있어도 뒤쪽 요소로 포커스가 이동합니다.
  - 모바일 오류 알림(styles.css:293)이 최대 9초 동안 입력창과 보내기 버튼을 가립니다.
- **[L13] 느린 연결에서 업로드 실패 가능 (미검증)** — Node 기본 requestTimeout 300초(server.mjs:81)가 업로드 상한이 됩니다. 20 MiB를 올리려면 약 70 KB/s 이상이 계속 필요합니다.

**테스트 적절성**
- 본문 전송 중 클라이언트 연결이 끊겼을 때 부분 파일이 지워지는지 확인하는 테스트가 없습니다.
- 파일 symlink를 심어 둔 덮어쓰기 사례는 이 호스트에서 EPERM으로 건너뛰었는데 (test/uploads.test.mjs:179-185), 요약에는 skipped 0으로 나옵니다. README:60의 "링크를 따라가지 않는다"는 주장은 Windows에서 검증되지 않았습니다.
- DELETE 업로드 경로의 CSRF/Origin 거부 테스트, attempted 첨부 재전송 테스트가 없습니다.
- fake Codex(test/fake-codex.mjs:33-52)는 승인·입력 요청을 내보내지 않아, 새로 디자인한 승인 카드를 fixture로 브라우저 확인할 수 없습니다.
- `npm run check` 증거가 없습니다. 테스트가 public/app.js와 setup.mjs를 import하지 않으므로 이 두 파일의 문법은 증거로 확인되지 않았습니다. 직접 읽었을 때 오류는 찾지 못했습니다.

RUN: 허용된 두 명령만 실행했습니다. Get-ChildItem으로 파일 목록을 확인했고, git status --short로 전체가 untracked 상태임을 확인했습니다. 테스트, `node --check`, 브라우저, 실제 Codex는 실행하지 않았습니다(허용 명령이 아님). run-dir: C:\Codex\Scratch\claude-code-worker\runs\1790165763076-12124-3c7e23d9-c9f6-4ae1-9c59-36363cab699c (이 리뷰는 아무 파일도 쓰지 않았습니다).
EVIDENCE:
- 읽은 소스: server.mjs, lib/uploads.mjs, bridge/app-server.mjs(baseline과 크기·내용 동일), public/{app.js, index.html, styles.css, icon.svg}, test/{uploads, remote}.test.mjs, test/{fake-codex, fixture-files, ui-fixture}.mjs, README.md, package.json, config.example.json, setup.mjs, start.ps1, stop.ps1, .gitignore
- baseline 비교: work-artifacts/review-input/baseline/*
- work-artifacts/review-input/tests-main.txt: 22/22 통과, 기존 11개 테스트 이름 일치
- work-artifacts/test-evidence/uploads-2026-09-23T12-16-01-711Z-36304.json: `plantedSymlinkTested:false`, fake가 읽은 sha256이 올린 파일과 일치
CHANGES: 없음.
LIMITS:
- 허용 명령으로는 candidate-hashes.json의 해시를 계산할 수 없어, 읽은 파일이 고정 후보와 같은지 해시로 확인하지 못했습니다.
- remote.test.mjs의 baseline 사본이 없어 기존 테스트 보존은 이름과 개수로만 확인했습니다.
- M1, L2~L5, L11, L13은 코드로 추론한 위험이며 실행으로 확인하지 않았습니다. 메인의 브라우저·실환경 확인이 필요합니다.
- 권장 확인 항목:
  - Excel 셀 범위를 입력창에 붙여넣기
  - 390px에서 첨부 5개와 오류 알림 표시
  - 507/415 조기 거부 시 표시되는 메시지
  - 기록을 다시 불러온 뒤 첨부 칩 표시
  - Cloudflare Tunnel을 거쳐도 Content-Length가 유지되는지(유지되지 않으면 모든 업로드가 411로 거부됨)
- 알려진 danger-full-access 문제는 이번 범위 밖이며 그대로 남아 있습니다.