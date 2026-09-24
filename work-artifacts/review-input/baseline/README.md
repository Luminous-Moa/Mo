# Codex Remote Web

개인 Windows PC에서 실행되는 Codex App Server를 localhost 웹 패널로 제어하기 위한 실험용 도구입니다. 서버는 `127.0.0.1:47831`에만 바인딩합니다. 외부 HTTPS 주소는 Cloudflare Quick Tunnel이 이 localhost 연결을 전달할 때만 생깁니다.

## 준비

1. Node.js 20 이상과 Codex CLI를 설치합니다.
2. `node setup.mjs`를 한 번 실행합니다. 이 명령은 24바이트 무작위 접근 비밀번호의 scrypt 해시와 세션 키를 `C:\Codex\Apps\CodexRemoteWeb\data\runtime-config.json`에 저장합니다. 실제 초기 비밀번호는 `C:\Codex\2026-09-22\new-chat\outputs\CodexRemoteWeb-access.txt`에만 저장되며 콘솔에는 경로만 표시합니다.
3. 위 runtime config에서 `codexExe`, `codexHome`, `cloudflaredPath`, `allowedRoots`를 자신의 환경에 맞게 지정합니다. 비밀번호 원문은 config에 넣지 않습니다.
4. Cloudflare Quick Tunnel 시험 실행은 `powershell -ExecutionPolicy Bypass -File .\start.ps1`입니다. URL은 매 시작마다 바뀌고 가용성이 보장되지 않습니다. 명명된 도메인을 사용할 경우 `publicOrigin`을 그 정확한 HTTPS origin으로 지정합니다.
5. 종료는 `powershell -ExecutionPolicy Bypass -File .\stop.ps1`입니다.

초기 구성과 실행은 실제 Codex 사용자 작업을 자동 실행하지 않습니다. 새 작업, 프롬프트 전송, 중단, 명령/파일 변경 승인은 패널에서 명시적으로 수행해야 합니다. 모델과 추론 수준 선택은 다음 메시지부터 적용하며, 비워 두면 작업의 기존 기본값을 유지합니다. 권한·승인 기본값은 기존 Codex 구성에 맡깁니다.

## 보안 경계

Cloudflare 앞단 인증은 이 프로젝트가 제공하지 않습니다. Quick Tunnel URL을 비공개로 취급하고, 접근 비밀번호를 안전하게 보관하세요. 모든 API는 로그인 후 HttpOnly/SameSite=Strict 세션, 정확한 Host/Origin, CSRF 토큰을 확인합니다. 임의 터미널, 파일 브라우저, RPC는 제공하지 않습니다. 허용 루트 내부의 실제 존재하는 직접 하위 프로젝트만 선택할 수 있습니다.

## App Server 제한

기본 transport는 독립 `codex app-server` stdio입니다. 이는 같은 계정과 로컬 프로젝트를 사용하는 별도 웹 Codex 세션이며, 이미 데스크톱에서 실행 중인 turn을 제어한다는 약속은 하지 않습니다. 활성 상태이거나 다른 writer가 점유한 기존 작업을 resume하지 않습니다. 새 웹 작업이 신뢰할 수 있는 기본 흐름입니다. `proxy`는 별도의 명시적 실험 모드이며 자동 전환하지 않습니다. Quick Tunnel과 실제 Codex를 이 저장소의 테스트는 실행하지 않습니다.

## 검사

`npm test`는 로컬 fake JSONL App Server로 인증, CSRF, 경로 이탈, 세션 로그아웃, idempotency, 승인 왕복을 검사합니다. `npm run check`는 Node 문법을 검사합니다.
