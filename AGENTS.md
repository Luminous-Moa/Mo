# AGENTS.md — Codex Remote Web

이 PC의 Codex App Server(`codex app-server`, stdio)를 브라우저 웹 패널로 원격 제어하는 Windows용 Node 도구입니다. 서버는 루프백(`127.0.0.1`)에만 바인딩하고, 외부 접속은 Cloudflare Quick Tunnel이 전달합니다. 상세 명세는 `README.md`가 기준입니다.

원 개발 저장소에는 `AI-READ-FIRST.md`와 `knowledge/`(개발 지식그래프)가 있을 수 있습니다. 있으면 그 절차를 먼저 따르고, 배포본에는 없으므로 없으면 이 파일과 README만 따릅니다.

## 구조

- `server.mjs` — HTTP 서버, 인증·세션·CSRF, 작업 범위·보호 폴더 판정, API. `resolveSettings()`가 경로 해석 규칙의 기준 구현.
- `bridge/app-server.mjs` — Codex App Server JSONL 브리지, `resolveCodexExe()`(codex.exe 자동 탐색).
- `lib/uploads.mjs` — 첨부 저장소(소유 표식, 한도, 내용 서명 검사).
- `public/` — 웹 UI(`app.js`, `ui-core.js`, `dispatch-state.js`, `index.html`, `styles.css`).
- `setup.mjs` — 비밀번호 해시·세션 키가 든 runtime config 생성, data 폴더 ACL 잠금.
- `start.ps1` / `stop.ps1` — 터널+서버 기동(`-CheckOnly` 점검) / 자기 소유 프로세스만 종료. Windows PowerShell 5.1 호환 유지.
- `test/` — `*.test.mjs`(자동 테스트), `fake-codex.mjs`(fake App Server), `ui-fixture.mjs`(수동 UI 확인용).
- `config.example.json`, `.env.example` — 예시. 실제 runtime config는 data 폴더(기본 `%LOCALAPPDATA%\CodexRemoteWeb\data`)에만 있습니다.

## 명령 (저장소 루트, PowerShell)

- 설치: `node setup.mjs` → runtime config의 `allowedRoots`/`resumeRoots` 편집
- 점검: `powershell -ExecutionPolicy Bypass -File .\start.ps1 -CheckOnly` (아무것도 띄우지 않음)
- 기동: `powershell -ExecutionPolicy Bypass -File .\start.ps1`
- 종료: `powershell -ExecutionPolicy Bypass -File .\stop.ps1`
- 테스트: `node --test test/*.test.mjs` (= `npm test`, Node 21 이상 필요: Windows 셸은 `*`를 펼치지 않음)
- 문법 검사: `npm run check`
- UI fixture: `node test/ui-fixture.mjs` → `http://127.0.0.1:47832`

경로 해석 순서는 값마다 인자 > 환경 변수(`CODEX_REMOTE_DATA_DIR`, `CODEX_REMOTE_OUTPUT_DIR`, `CODEX_REMOTE_NODE_EXE`) > 저장소 루트의 `local.settings.json`(git 제외) > 기본값입니다. 기준 구현은 `server.mjs`의 `resolveSettings()`이고, `start.ps1`·`stop.ps1`은 표시된 공유 블록(두 파일에서 글자까지 같아야 함)으로 표준 JSON 범위에서 같은 규칙을 구현합니다: 키 대소문자 구분, 문자열이 아닌 값은 오류, 드라이브 절대 경로·UNC만 허용, JSON 오류에 파일 내용을 출력하지 않음(Windows PowerShell 5.1은 작은따옴표 등 비표준 JSON도 받아들일 수 있음). Windows PowerShell 5.1은 Node 출력을 콘솔 코드페이지(한국어 949)로 읽으므로 Node→PS로 넘기는 값은 ASCII(퍼센트 인코딩)로 보내고, `Start-Process` 인자는 `ConvertTo-CommandLine`으로 인용합니다. 규칙을 바꾸면 `server.mjs`·두 스크립트의 공유 블록·README·`test/portable-config.test.mjs`(PS·Node 동등성 테스트)를 함께 맞춥니다. `CODEX_REMOTE_CONFIG`는 start.ps1이 서버에 config 파일을 넘기는 내부 변수입니다.

## 규칙

- runtime config, 접근 비밀번호 파일, 터널 URL, `local.settings.json`, data 폴더 내용(세션 키·해시·업로드·로그)을 커밋하거나 출력·로그·응답에 넣지 않습니다. setup은 비밀번호 원문을 콘솔에 출력하지 않습니다.
- 테스트는 fake App Server(`test/fake-codex.mjs`)와 임시 폴더만 씁니다. 실제 `~\.codex`, 실제 data 폴더, 실제 `codex.exe`·cloudflared를 테스트에서 실행하거나 바꾸지 않습니다. 환경은 주입(`env`, `root`, `spawnImpl`, `resolveExe` 등)해서 검사합니다.
- 보안 경계를 약화하지 않습니다: 루프백 바인딩, HTTPS `publicOrigin`, 로그인·HttpOnly/SameSite=Strict 세션, 정확한 Host/Origin, CSRF 토큰, `allowedRoots`/`resumeRoots` 범위, 보호 폴더(data 폴더·업로드 저장소) 판정과 fail-closed 경로 정규화, 업로드 내용 검사.
- 작업 트리의 다른 변경을 보존하고, 요청 없이 커밋·푸시하지 않습니다.

## 알려진 한계

- 단일 writer: Codex는 작업마다 한 프로세스만 쓰기를 허용합니다. 데스크톱 앱이 연 작업은 앱을 트레이까지 완전히 종료해야 웹에서 이어갈 수 있고(409 `thread_locked`), 웹이 이어간 작업을 데스크톱에서 계속하려면 `stop.ps1`로 서버를 먼저 멈춥니다(README "데스크톱 ↔ 웹 인계 절차").
- 권한: `codex app-server`는 사용자의 전역 Codex 설정을 상속하며 `danger-full-access`일 수 있습니다. 프로젝트 선택은 샌드박스가 아닙니다.
- 재연결 없음: App Server 연결이 끊기면 자동으로 다시 붙지 않습니다. 서버를 다시 시작합니다.
- Quick Tunnel URL은 시작마다 바뀌고 가용성이 보장되지 않습니다. Cloudflare 앞단 인증은 제공하지 않습니다.
