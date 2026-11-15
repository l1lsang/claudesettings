# IDEA ARENA — 아키텍처

## 구성

- **GPT 에이전트** (`src/engine/`, `src/orchestration/agent-tasks.ts`) — 생성·심사·토론·개선을 하는 주체. OpenAI 호환 Chat Completions(JSON 모드), 기본 Letsur 게이트웨이.
  - 에이전트 작업 하나 = 모델 호출(+검증 실패 시 오류를 알려 주고 최대 2회 재작성). 결과는 그 에이전트 몫의 경로에만 쓴다.
  - 프롬프트에는 그 에이전트가 볼 수 있는 파일만 넣는다(심사위원: blind/·evaluations/·debates/, 생성자: 자기 feedback.json).
- **TypeScript 오케스트레이터** (`runner.ts`) — 상태 전이, 산출물 검증, 익명화, 점수 계산, 보고서 생성. 상태를 바꾸는 유일한 주체.
- **진행자** — 단계 담당 에이전트를 병렬로 돌리고 `advance`를 호출한다. 웹은 브라우저(`public/app.js`), CLI는 `autopilot.ts`. (예전 방식: Claude Code Team Lead가 같은 순서를 수동으로)
- **상황 프리셋** (`src/domain/presets.ts`) — 생성자·심사위원·평가 항목 슬롯의 이름·관점·기준·가중치를 상황(범용, 서비스·창업, 연구, 마케팅, 전략·정책, 창작)에 맞게 바꾼다. `input.json`·`state.json`의 `preset`(없으면 서비스·창업).

## 웹 앱 (Vercel)

- 서버 DB 없음. 실행 디렉터리 전체(`{상대경로: 내용}`)를 브라우저 IndexedDB가 보관하고 요청마다 `files`로 보낸다.
- `/api`(함수 하나)는 요청마다 임시 디렉터리에 파일을 펼쳐 오케스트레이터를 디스크 모드 그대로 실행하고, 결과 디렉터리를 묶어 돌려준 뒤 지운다(`workspace.ts`). 그래서 CLI와 웹이 같은 검증·write-once·이벤트 코드를 쓴다.
- 접근 제어: `APP_PASSWORD`와 비교(상수 시간) → 만료 시각에 HMAC(키=비밀번호) 서명한 HttpOnly·SameSite=Strict 쿠키(7일). 비밀번호를 바꾸면 세션이 모두 무효.
- 파일 경로는 `[A-Za-z0-9_.-]` 세그먼트만, 최대 300개·4MB. 함수 시간 제한 300초 — 에이전트 작업은 285초 안에서, 남은 시간이 90초 미만이면 재시도하지 않는다.
- 빌드: `scripts/build-vercel.mjs` → `.vercel/output`(Build Output API v3: static/ + functions/api.func).

## 상태 머신

```
CREATED → GENERATING → BLINDING* → SCORING ─┬─ 불일치 → DEBATING → REVISING
                                            └─ 일치 ─────────────→ REVISING
REVISING → RESCORING → FINALIZING* → COMPLETED
(COMPLETED 제외 모든 단계) → FAILED → (실패한 단계로만 복구)
```
`*` 자동 단계: 에이전트 작업 없이 `advance` 한 번에 통과한다.

각 단계는 `src/orchestration/runner.ts`의 핸들러 세 개로 정의된다.

| 단계 | enter (진입 시 오케스트레이터가 준비) | check (전이 조건) | complete (파생 파일 → 다음 단계) |
|---|---|---|---|
| CREATED | — | input.json 유효 | → GENERATING |
| GENERATING | — | 생성자 3명 × 아이디어 2개 = 6개 | → BLINDING |
| BLINDING | 셔플·IDEA-ID 부여, mapping.json, blind/v1 | 익명 패키지 6개 유효 | → SCORING |
| SCORING | — | 심사위원 2명 × 6개 = 평가 12개 | aggregate(1) → 불일치 있으면 DEBATING, 없으면 REVISING |
| DEBATING | agenda.json(격차 큰 순) | 두 심사위원이 모든 안건에 입장 제출, `from` = 1차 점수 | resolution.json → REVISING |
| REVISING | 생성자별 feedback.json | 생성자별로 자기 아이디어 개선본 전부 | → RESCORING |
| RESCORING | blind/v2 (개선본 익명화) | 재평가 12개 | aggregate(2) → FINALIZING |
| FINALIZING | ranking.json, report.md | 보고서 필수 섹션·TOP 3 포함 | → COMPLETED |

**검증 실패**는 FAILED가 아니라 **전이 중단**(상태 유지, `ADVANCE_BLOCKED` 이벤트)이다. 에이전트가 파일을 고친 뒤 다시 `advance`하면 된다.
**FAILED**는 오케스트레이터 작업 중 예외(파일 충돌, 완료된 단계 파일 변조 등)에만 발생하고, `retry`는 실패 단계의 enter를 다시 수행한 뒤 진행한다.

## 저장 원칙

- `state.json`은 `state.json.tmp`에 쓴 뒤 rename으로 교체(원자적). Windows/OneDrive 잠금에 대비해 rename 재시도.
- 모든 단계 산출물은 **write-once**: 같은 내용 재기록은 무시, 다른 내용이면 `ImmutableArtifactError` → FAILED(재시도 불가). 원본·최초 점수가 덮어써지지 않는다.
- 파생 파일은 입력만의 순수 함수(시각·난수 없음). 익명화 셔플 시드는 runId. 그래서 재시도가 멱등이다.
- 실행 단위 잠금(`.lock`)으로 CLI 동시 실행 방지.
- `events.jsonl`에 생성·전이·중단·실패·복구·경고를 모두 기록.

## 실행 디렉터리

```
runs/<run-id>/
├── input.json, state.json, events.jsonl
├── private/                       ⛔ 심사위원 접근 금지
│   ├── generations/<generator>.json   [생성자]   원본 아이디어
│   └── mapping.json                   [오케]     IDEA-ID ↔ 생성자
├── blind/                         ✅ 심사위원 읽기
│   ├── v1/IDEA-00N.json               [오케]     익명 원본
│   └── v2/IDEA-00N.json               [오케]     익명 개선본(+changelog, rejectedFeedback)
├── evaluations/round-{1,2}/
│   ├── <judge>.json                   [심사위원]
│   └── aggregate.json                 [오케]     가중 점수, 격차, 불일치 사유
├── debates/round-1/
│   ├── agenda.json                    [오케]
│   ├── <judge>.json                   [심사위원] 입장, 반박, 인정, 점수 변경(근거 유형)
│   └── resolution.json                [오케]     토론 후 점수, 근거 유형 집계, 미해결
├── revisions/<generator>/         ⛔ 심사위원 접근 금지
│   ├── feedback.json                  [오케]
│   └── revised.json                   [생성자]
└── final/ranking.json, report.md      [오케]
```

## 점수

- 항목별 0~5 정수. 가중치: 문제 해결 가치 25, 독창성 20, 구현 가능성 20, MVP 검증 용이성 20, 차별성 15.
- 심사위원 점수 = Σ wᵢ·sᵢ/5 (0~100). 아이디어 점수 = 두 심사위원 평균.
- 토론 대상: 총점 차이 ≥ 15, 또는 어떤 항목이든 차이 ≥ 2, 또는 심사위원이 `criticalIssues`를 하나라도 기록.
- 토론의 점수 변경은 근거 유형을 반드시 기록: `NEW_ARGUMENT` / `PEER_PERSUASION` / `ERROR_CORRECTION`. 동조와 새 논거를 구분해 집계한다.
- 토론 후에도 격차가 남은 아이디어는 `unresolved`로 남긴다(합의 강제 없음).
- 순위: 최종(재평가) 점수 → 동점이면 심사 격차가 작은 쪽 → 문제 해결 가치 평균 → ID.
- 가중치·임계값은 실행마다 `state.json`의 `config.scoring`에 저장된다(v1.0의 가중치 실험 대비).

## 알려진 한계

- GPT 실행에서는 심사위원 프롬프트에 익명 데이터만 들어간다(코드로 보장). 예전 Claude Code 팀 방식은 같은 디렉터리를 공유하므로 운영 규칙으로만 보장된다.
- 웹 실행 데이터는 그 브라우저에만 있다. 브라우저 데이터를 지우면 사라지므로 내보내기로 백업한다. 여러 기기 공유가 필요하면 Firebase(Firestore)를 저장소로 붙인다.
- 익명화 검사는 본문에 에이전트 이름이 있는지 보는 경고 수준이다. 문체로 작성자를 추측하는 것은 막지 못한다.
- 재평가 점수 상승에는 피드백 효과와 같은 심사위원의 관대화가 섞일 수 있다. 단일 모델 베이스라인과 비교 실험이 필요하다(README "연구 질문").
