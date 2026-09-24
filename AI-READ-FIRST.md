# Codex Remote Web: 먼저 읽기

목적은 **README → 지식그래프 → 실제 코드와 검증 근거** 순서로 개발 맥락을 이어가는 것입니다. 지식 SQLite(`knowledge/graph.sqlite3`)는 제품 런타임 데이터(`C:\Codex\Apps\CodexRemoteWeb\data\`의 runtime config·업로드 저장소)와 별개이며, 비밀번호·세션 키·해시·터널 URL·인증 정보를 저장하지 않습니다.

이 절차는 메인만 수행합니다. 워커에게는 필요한 소스·로그·판단 근거만 선별해 전달하며, 워커는 이 진입 문서·`ai/entry.json`·기준 DB·백업·전체 export를 열거나 관리 명령을 실행하지 않습니다. 지식관리 도구 자체를 시험할 때의 임시 합성 DB는 별도입니다.

## 다음 작업 진입 순서

1. 최신 사용자 요청과 적용 지침이 그래프보다 우선합니다. `git status --short`와 현재 커밋을 확인해 다른 변경을 보존합니다.
2. [기계 판독 진입점](ai/entry.json)과 [개요](knowledge/OVERVIEW.md)를 확인합니다. 경로/DB 스키마를 추정하지 않습니다.
3. 프로젝트 루트에서 현재 schema/revision/최신 세션과 무결성·코드 참조 상태를 확인합니다.

```powershell
$py = 'C:/Users/glalm/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
& $py -X utf8 scripts/knowledge.py status
& $py -X utf8 scripts/knowledge.py check
& $py -X utf8 scripts/knowledge.py show goal.remote_continuity
```

4. 요청 키워드로 필요한 노드만 찾아 incoming/outgoing 관계를 따라 실제 코드·테스트를 읽습니다. 매번 전체 그래프를 대화에 넣지 않습니다.

```powershell
& $py -X utf8 scripts/knowledge.py search "writer"
& $py -X utf8 scripts/knowledge.py show issue.single_writer_lock
& $py -X utf8 scripts/knowledge.py show open.continuity_approach
& $py -X utf8 scripts/knowledge.py show code.server.list_tasks
```

5. 검증 상태와 근거 날짜를 구분합니다. check의 지문 경고는 소스 재검토 필요를 뜻하며 동작 오류나 테스트 실패와 같지 않습니다. 그래프에 테스트가 연결되어 있다는 이유로 최근 통과를 주장하지 않습니다.

`python`이 PATH에 있으면 그것을 써도 됩니다. Python 표준 라이브러리만 필요하고 외부 패키지·DB 서버는 없습니다. 기본 루트는 스크립트 위치의 상위 폴더, DB는 `knowledge/graph.sqlite3`입니다.

## 저장 구조

- `knowledge/graph.sqlite3`: 기준 원본. `nodes`, `edges`, `revisions`, `node_history`, `edge_history`, `meta` 테이블.
- `knowledge/OVERVIEW.md`: 사람이 읽는 목적·구조·탐색 지도. 핵심 내용이 바뀌면 DB 반영과 함께 검토합니다.
- `knowledge/VALIDATION.md`: 지식그래프 구축·갱신의 실제 검증 기록.
- `knowledge/exports/revision-NNNNNN/`: 해당 revision의 `graph.json`, `graph.mmd`, `graph.md`, `overview.md`. 자동 생성한 읽기용 파일이며 원본으로 편집하지 않습니다.
- `knowledge/backups/`: 적용 직전 SQLite backup. Git 제외, 복구 판단 시 메인만 확인합니다. 파일명 revision은 적용 예정 revision이므로 백업 내부 meta도 확인합니다.
- `scripts/knowledge.py`, `scripts/tests/test_knowledge.py`: WeatherAir 프로젝트의 도구를 2026-09-24 그대로 복사한 것(`code.kg_tool` 노드에 원본 SHA256 기록).
- 코드 노드: 프로젝트 상대 경로 + 정확한 앵커 문자열 + SHA256 + 앵커 줄 번호. 줄 번호 단독을 영구 식별자로 쓰지 않습니다.

상태: `verified`는 문장에 명시한 범위를 직접 확인, `documented`는 문서·사용자 발언 근거, `historical`은 과거 시점, `hypothesis`는 미확정, `untested`는 미검증·미결입니다. 코드 존재 확인과 런타임 성공은 다른 사실입니다. 실패 기록을 삭제하거나 미검증을 확정으로 바꾸지 않습니다.

## 안전한 갱신

직접 SQL 수정, DB 덮어쓰기, 기존 DB에서 init 재실행을 하지 않습니다. 도구는 삭제 연산을 제공하지 않으며 같은 ID 갱신 시 이전 payload를 이력에 남깁니다. 폐기된 결정은 historical 상태와 후속 관계로 남깁니다. 소스가 이동하면 기존 코드 노드 ID를 유지하고 경로/앵커를 수정합니다.

1. status/check로 현재 revision N과 문제를 확인합니다. 실제 소스/결과를 검토하고 변경할 노드·관계만 JSON에 작성합니다. 작업용 입력과 긴 로그는 `C:/Codex/Scratch/CodexRemoteWebKnowledge/`에 서로 다른 이름으로 보존합니다.
2. 노드 필수 필드는 `id, kind, title, summary, status, evidence`, 선택 필드는 `path, symbol`입니다. 관계 필드는 `id, source, target, relation, summary, evidence`입니다. URL(`http://`, `https://`)은 evidence에만 넣을 수 있으며, 터널 URL은 evidence에도 넣지 않습니다. 지문/줄번호는 도구가 계산합니다.
3. 새 작업의 목표·범위·실패·검증 여부를 session 노드와 관계로 기록하고 실제 근거를 연결합니다. 사용자 승인 결정은 결정 시점의 원문을 decision 노드에 보존합니다.
4. 같은 입력·revision으로 dry-run을 확인한 뒤 적용합니다.

```powershell
& $py -X utf8 scripts/knowledge.py apply C:/Codex/Scratch/CodexRemoteWebKnowledge/change.json --expect-revision N --session YYYYMMDD-topic --dry-run
& $py -X utf8 scripts/knowledge.py apply C:/Codex/Scratch/CodexRemoteWebKnowledge/change.json --expect-revision N --session YYYYMMDD-topic
& $py -X utf8 scripts/knowledge.py check
& $py -X utf8 scripts/knowledge.py export --out knowledge/exports
& $py -X utf8 scripts/knowledge.py status
```

`BEGIN IMMEDIATE` 안에서 revision을 비교하고 검증·적용합니다. 충돌이면 최신 DB와 사용자 변경을 다시 검토하며 번호만 바꿔 강행하지 않습니다. dry-run은 DB/백업을 바꾸지 않습니다. 동일 내용은 no-op입니다. DB 적용 후 export만 실패했다면 **apply를 반복하지 말고 export만 재실행**합니다. check 오류나 해결하지 못한 코드 변경 경고는 사용자 보고에 남깁니다. 완료 시 DB·문서·출력과 실제 검증 결과를 Git에서 함께 검토합니다.

도구 회귀 시험은 `& $py -X utf8 -m unittest -v scripts.tests.test_knowledge`이며 임시 합성 DB만 씁니다.

## 범위

초기 기준은 2026-09-24 첫 커밋 직전 작업 트리입니다. 이후 현재 동작은 실제 소스·실행 증거로 확인합니다. 실제 Codex App Server·Quick Tunnel·데스크톱 앱 동작은 저장소 테스트 범위 밖이며, 그래프에는 관측한 날짜·조건과 함께 기록합니다. Notion·외부 업로드는 지식 조회 때문에 자동 수행하지 않습니다.
