# 지식그래프 구축 검증 — 2026-09-24

기준: 첫 Git 커밋 직전 작업 트리. 이번 작업은 지식관리 도구·문서·DB 추가와 커밋 범위 정리이며 제품 코드(`server.mjs`, `bridge/`, `lib/`, `public/`, `test/`, 스크립트)는 바꾸지 않았습니다.

## 기준 DB 실제 검증

- `knowledge/graph.sqlite3`: schema 1, revision 1, session `20260924-knowledge-bootstrap`.
- 63 nodes / 119 edges / 파일·앵커 참조 35건.
- 적용 전 dry-run: revision 0 유지, 63/119 변경 예정, 백업 미생성 확인. 실제 적용: revision 1.
- SQLite integrity/FK, 코드 경로·앵커·지문 check: 오류 0 / 경고 0.
- export JSON의 nodes·edges 정규화 SHA256과 revision 1의 payload_hash 일치.
- 출력 `knowledge/exports/revision-000001/`: graph.json / graph.mmd / graph.md / overview.md.
- 적용 직전 백업 1건(`revision-000001-473e3cc56aad.sqlite3`), 내부 meta revision 0·노드 0 확인. 백업명의 revision은 적용할 revision입니다.
- `show issue.single_writer_lock`: 들어오는 관계 5, 나가는 관계 3. `search writer`: 23건.
- 비밀 검사(export graph.json): Quick Tunnel URL, 이메일 주소, hash/salt/sessionKey 필드, bearer 토큰 형태 모두 없음.
- 로컬 링크: AI-READ-FIRST 2, graph.md 35, overview.md 12개 모두 존재. OVERVIEW 16개 중 이 파일(VALIDATION.md) 1개가 검증 시점에 아직 없었고 이 문서 작성으로 해소했습니다.
- Mermaid는 텍스트 출력만 생성했고 브라우저 렌더링은 확인하지 않았습니다.

원본 실행 기록: `C:/Codex/Scratch/CodexRemoteWebKnowledge/`의 `bootstrap-change-v2.json`(적용 입력), `bootstrap-dry-run.json`, `bootstrap-apply.json`, `bootstrap-check.json`, `bootstrap-export.json`, `bootstrap-status.json`, `bootstrap-verification.json`. 입력 초안 `bootstrap-base-v1.json`, `bootstrap-edges-v1.json`, `bootstrap-review-additions-v1.json`과 병합 스크립트 `merge-bootstrap.mjs`, 검증 스크립트 `verify-bootstrap.py`도 함께 보존합니다. 각 파일을 덮어쓰지 않았습니다.

## 관리 도구

`scripts/knowledge.py`와 `scripts/tests/test_knowledge.py`는 `C:/Codex/Projects/WeatherAir/scripts/`에서 바이트 그대로 복사했습니다(SHA256 각각 `FC5D6E50…9923`, `6AA6B949…D379`, 전체 값은 `code.kg_tool`·`test.kg_tool` 노드). 원본은 WeatherAir 저장소에서도 미커밋 상태입니다.

도구 테스트: `python -X utf8 -m unittest -v scripts.tests.test_knowledge` 13개 중 12 통과, 1 skipped(디렉터리 symlink 생성 권한 없음), 종료 0. Python 3.12.14 번들 런타임, 임시 합성 DB만 사용. 로그 `C:/Codex/Scratch/CodexRemoteWebKnowledge/tooltest-20260924-1.log`.

## 제품 검사 (같은 작업 트리)

- `node --check` 8개(package.json `check` 대상) 모두 종료 0.
- `node --test test/*.test.mjs` 50개 중 49 통과, 1 skipped(파일 symlink 생성 권한 없음), 실패 0, 종료 0. Node v24.21.0.
- 원본: `work-artifacts/test-evidence/initial-commit-validation-raw-20260924.txt` 및 같은 실행이 만든 JSON 3개.
- 독립 reviewer 전체 검토: critical 없음, HIGH 5·MEDIUM 3·LOW 11. 지적은 `review.20260924`와 연결된 `issue.*` 노드에 기록했고 코드는 아직 고치지 않았습니다.

## 하지 않은 검증

실제 브라우저 화면, 실기기 터치, Cloudflare를 거친 업로드, 공식 원격 제어 접속, Codex 앱 안에서 띄운 웹 서버의 수명은 확인하지 않았습니다. 앱 종료 후 웹 인계 성공은 사용자 보고(`obs.user_handover_success_20260924`)이며 메인이 화면을 직접 보지 않았습니다.

# revision 2 검증 — 2026-09-24 데스크톱 이어가기

기준: 첫 커밋 3748874 + 미커밋 변경(후보 r4: server.mjs `AED584A11A85EA67`, test/task-scope.test.mjs `14B4AF128CEC1692`, README.md `FEB5C163D09AAFA7`, 나머지 파일은 `C:/Codex/Scratch/CodexRemoteWebKnowledge/candidate-desktop-resume-r3-20260924.json`과 동일). 운영 배포는 이 작업 트리로 했습니다.

## 기준 DB

- schema 1, revision 2, session `20260924-desktop-resume`. 86 nodes / 187 edges.
- dry-run: revision 1 유지, 노드 50(갱신 27·신규 23)·관계 68 변경 예정. 실제 적용: revision 2.
- check: 오류 0 / 경고 0. 적용 전 check는 코드 변경으로 앵커 누락 6건·지문 경고를 정확히 보고했고, 해당 노드를 새 앵커로 갱신해 해소했습니다.
- export `knowledge/exports/revision-000002/`의 정규화 SHA256과 payload_hash 일치.
- node_history revision 2: 27건(갱신 전 payload 보존, 예: `issue.task_list_hidden` 이전 status verified → 현재 historical).
- 적용 직전 백업 `revision-000002-5b1149c894d3.sqlite3` 내부 meta revision 1·노드 63.
- 비밀 검사(export graph.json): Quick Tunnel URL, 이메일, hash/salt/sessionKey 필드, bearer 토큰 형태 없음.

원본: `C:/Codex/Scratch/CodexRemoteWebKnowledge/`의 `20260924-web-panel-decision-draft.json`(결정 시점 원문), `rev2-nodes-v1.json`, `rev2-edges-v1.json`, `merge-rev2.mjs`, `rev2-change-v1.json`, `rev2-dry-run.json`, `rev2-apply.json`, `rev2-check.json`, `rev2-export.json`, `rev2-status.json`, `verify-rev2.py`, `rev2-verification.json`, `deploy-listing-probe.mjs`, `deploy-listing-probe-output.txt`, 후보 해시 `candidate-desktop-resume-*.json`.

## 제품 검증

- 최종 후보 r4: `node --check` 10개 종료 0, `node --test` 72개 중 71 통과·1 skipped(파일 symlink 권한)·실패 0.
- 임시 CODEX_HOME에서 실제 codex 0.155.0-alpha.16.3 두 프로세스 e2e 18/18(r3 후보; r4는 보호 경로 판정 함수만 변경). notLoaded 탐침 PASS.
- 실제 계정 기록에 기록 API 적용(읽기 전용): new-chat 5/5/3 turn, 27.6 MiB turn은 요약 재시도로 열림.
- 독립 리뷰 3회(r1·r2·r3) 블로커 없음. r3 뒤 F1(드라이브 상대 경로) 3줄 수정은 메인이 코드를 직접 확인했고 별도 독립 리뷰는 없습니다.
- 배포 전 실제 데이터 목록 탐침(읽기 전용): 50개, 날짜 폴더 22·프로젝트 7·Documents 20(폴더 없음)·보호 1·잠김 2.
- 배포 후: 서버·터널·웹 app-server 실행, 로컬·외부 /health 200, stderr 0바이트, writer lock 해제.

## 하지 않은 검증

로그인 후 브라우저 화면(목록 표시, 이전 기록 더 보기, 안내 카드, 포커스·스크롤), 실제 데스크톱 앱이 잡은 잠금으로 409 확인, 실제 모델 turn의 승인 흐름(patchUpdated 순서, 자동 거부가 decline으로 처리되는지), 드라이브 상대 경로가 실제 쓰기로 이어지는지는 확인하지 않았습니다. revision 2 기록 시점에는 변경 코드가 미커밋이었습니다.

# revision 3 — 2026-09-24 커밋 기록

- 사용자 요청('커밋 진행해줘.')으로 커밋 1477b14(코드 + revision 2, 65개 파일)를 만든 뒤, 그 사실을 revision 3으로 기록했습니다. session `20260924-desktop-resume-commit`, 88 nodes / 192 edges, dry-run 노드 4·관계 5, check 오류 0 / 경고 0.
- 커밋 직후 추적 파일 131개 모두 git 저장 바이트와 작업 폴더 바이트 일치. server.mjs·test/task-scope.test.mjs·README.md 해시가 후보 r4와 같고 마지막 수정 시각이 서버 기동(16:42:42)보다 앞서, 배포된 코드와 커밋된 코드가 같습니다.
- 원본: `C:/Codex/Scratch/CodexRemoteWebKnowledge/rev3-change-v1.json`, `rev3-dry-run.json`, `rev3-apply.json`, `rev3-check.json`, `rev3-export.json`, `rev3-status.json`.

# revision 4 — 2026-09-24 타인 Codex용 이식성·공유 패키지

- session `20260924-share-handoff`, 101 nodes / 217 edges. dry-run 노드 54(설명 유지 지문 갱신 33, 설명 변경 8, 신규 13)·관계 25, check 오류 0 / 경고 0, export 정규화 SHA256과 payload_hash 일치, node_history revision 4 41건, 비밀 검사(터널 URL·이메일·hash/salt/sessionKey 필드) 없음.
- 적용 전 check는 코드 변경으로 41개 노드의 지문 불일치를 보고했습니다(앵커 누락 0). 설명이 그대로인 노드는 독립 감사 r1~r3가 본 diff를 근거로 지문만 갱신했고, 설명이 바뀐 노드(setup, start/stop, 브리지, README, codexExe 이슈 등)는 새 설명으로 교체했습니다.
- 제품 검증: 최종 작업 트리 `node --test` 94개 중 93 통과·1 skipped·실패 0, 배포 29개 파일과 최종 zip 해제본 민감정보 스캔 0건, 소유자 `-CheckOnly` 운영 경로 동일. 공유 zip 179,222 bytes, SHA256 `40D51116FFF073CAA0EBC99D1732E7A74E5AA5EEEF53289F4974137513594275`. Drive 업로드는 크기·이름·위치·권한(소유자만)을 Drive API로 대조했고 체크섬은 Drive 메타데이터에 없어 대조하지 못했습니다.
- 원본: `C:/Codex/Scratch/CodexRemoteWebKnowledge/`의 `20260924-handoff-decision-draft.json`, `rev4-new-v1.json`, `merge-rev4.mjs`, `rev4-change-v1.json`, `rev4-dry-run.json`, `rev4-apply.json`, `rev4-check.json`, `rev4-export.json`, `rev4-status.json`, `rev4-verification.json`, 패키지 매니페스트 `CodexRemoteWeb-source-0.2.0-share-20260924-r*.manifest.json`, 빌드 스크립트 `build-handoff-zip*.ps1`.
