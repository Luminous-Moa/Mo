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
