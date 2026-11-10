# IDEA ARENA — 프로젝트 규칙

여러 Claude 에이전트가 아이디어를 **독립 생성 → 익명 심사 → 교차 토론 → 개선 → 재평가**하는 로컬 연구 도구다.
목표는 합의가 아니라, 서로 다른 관점이 근거를 갖고 끝까지 경쟁하는 과정을 데이터로 남기는 것이다.

## 두 가지 작업 모드

| 모드 | 하는 일 | 규칙 |
|---|---|---|
| **개발** | `src/`, `tests/` 코드 수정 | 아래 "개발 규칙" |
| **연구 실행** | Agent Team으로 실제 아이디어 연구 | 아래 "Team Lead 프로토콜". 프롬프트는 `docs/EXECUTION_PROMPT.md` |

두 모드는 **별도 Claude Code 세션**에서 진행한다(한 세션에 팀은 하나만 유지된다).

## 개발 규칙

- 스택: Node.js + TypeScript + Zod + Vitest. 서버·DB·로그인 없음.
- 변경 후 반드시 `npm run check` (typecheck + test) 통과.
- `src/domain/`은 순수 로직(스키마, 점수, 상태 전이)만. 파일 I/O는 `src/orchestration/`에서만.
- 파생 파일은 입력만으로 결정되어야 한다(현재 시각·난수 금지). 재시도 시 write-once 충돌을 막기 위해서다.
- 스키마를 바꾸면 `briefs.ts`의 템플릿, `.claude/agents/*.md`, 테스트 fixture를 같이 고친다.
- `runs/`는 원본 연구 데이터다. Git에 올리지 않고, 코드 변경 때문에 기존 실행 파일을 고치지 않는다.

## Team Lead 프로토콜 (연구 실행)

Team Lead(메인 세션)는 **관리자**다. 아이디어를 쓰거나 점수를 매기지 않는다 — 작성자를 아는 Lead가 평가에 관여하면 익명성이 깨진다.

### 원칙
1. **상태 변경은 CLI로만.** `state.json`, `events.jsonl`, 오케스트레이터 산출물(`mapping.json`, `blind/`, `aggregate.json`, `agenda.json`, `resolution.json`, `feedback.json`, `final/`)을 손으로 만들거나 고치지 않는다.
2. **완료된 단계의 파일은 덮어쓰지 않는다.** 원본·개선본, 최초·최종 점수 모두 보존한다.
3. **정보 격리**: 생성 단계에서는 생성자끼리, 1차 심사에서는 심사위원끼리 서로의 결과를 보지 않는다. 심사위원은 `private/`, `revisions/`를 읽지 않는다.
4. **반복 제한**: 토론 1회, 개선 1회, 재평가 1회. 그 이상 돌리지 않는다.
5. **동조 금지**: 팀원에게 "합의하라"고 지시하지 않는다. 메시지에 다른 팀원의 결론을 옮기지 않는다(파일로만 전달).

### 실행 순서
```
npm run arena -- create --topic "<주제>" --constraint "<제약>" ...
npm run arena -- advance --run <id>                   # CREATED → GENERATING
```
각 단계마다 다음을 반복한다.
1. `npm run arena -- status --run <id>` 로 담당자와 필요한 파일 확인
2. 담당 팀원마다 `npm run arena -- brief --run <id> --agent <agent>` 출력을 **그대로** 메시지로 보낸다
3. 모든 담당자가 완료를 알리면 `npm run arena -- advance --run <id>`
4. "전이 중단"이면 오류 목록을 해당 팀원에게만 전달해 고치게 하고 3으로

| 단계 | 담당 | 팀원에게 보낼 brief |
|---|---|---|
| GENERATING | creative, problem, business (병렬) | `--agent creative` / `problem` / `business` |
| SCORING | feasibility, innovation (병렬) | `--agent feasibility` / `innovation` |
| DEBATING (불일치 시에만) | feasibility, innovation (병렬) | 〃 |
| REVISING | creative, problem, business (병렬) | 〃 |
| RESCORING | feasibility, innovation (병렬) | 〃 |

BLINDING, FINALIZING은 `advance`가 자동 처리한다. COMPLETED가 되면 `npm run arena -- report --run <id>`.
사용자는 별도 터미널에서 `npm run dashboard`로 진행 상황과 결과를 웹으로 볼 수 있다(Lead가 띄울 필요 없음).

### 실패 시
- `advance`가 FAILED를 반환하면 `status`로 오류를 보고, 관련 입력·출력 파일을 확인한 뒤 `npm run arena -- retry --run <id>`.
- "재시도 불가(덮어쓰기 충돌)"는 완료된 산출물이 바뀌었다는 뜻이다. 어떤 파일이 왜 바뀌었는지 사용자에게 보고하고 지시를 받는다. 임의로 지우지 않는다.
- 세션을 재개했는데 팀원이 복원되지 않았다면 `status`로 현재 단계를 확인하고 그 단계 담당자만 새로 띄운다. 진행 상태는 `runs/<id>/`에 모두 남아 있다.

## 디렉터리
```
src/domain/          schemas.ts, scoring.ts, state-machine.ts, constants.ts
src/orchestration/   runner.ts(단계 핸들러), anonymizer.ts, validator.ts, persistence.ts, briefs.ts, paths.ts
src/reports/         generator.ts (ranking.json, report.md)
src/cli/             index.ts
src/web/             로컬 대시보드 (server.ts, data.ts, public/) — 읽기 전용, runs/에 절대 쓰지 않음
.claude/agents/      생성자 3명 + 심사위원 2명 정의
runs/<id>/           실행 데이터 (Git 제외) — 레이아웃은 docs/architecture.md
```
