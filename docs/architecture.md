# IDEA ARENA v0.1 — 아키텍처

## 구성

- **Claude Code Agent Teams** — 실제 생성·심사·토론을 하는 주체. Team Lead(메인 세션) + 팀원 5명.
- **TypeScript 오케스트레이터(CLI)** — 상태 전이, 산출물 검증, 익명화, 점수 계산, 보고서 생성. 상태를 바꾸는 유일한 주체.

에이전트는 정해진 경로에 JSON 파일을 쓰고, Team Lead는 `advance`로 검증·전이를 요청한다. 대화 기록과 실행 상태는 분리되어 있어서 세션이 끊겨도 `runs/<id>/`로 이어서 진행할 수 있다.

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

## 결과 대시보드

`npm run dashboard` → `src/web/server.ts` (node:http, 의존성 없음).

- 127.0.0.1에만 바인딩하고 Host 헤더도 localhost/127.0.0.1만 허용(DNS 리바인딩 방지). GET/HEAD만 받는다.
- `src/web/data.ts`가 `runs/<id>/`를 읽어 한 묶음 JSON으로 만든다. 쓰는 중이라 깨진 JSON은 경고로만 처리.
- `private/generations/`와 `revisions/`는 내보내지 않는다. 작성자 매핑은 COMPLETED일 때만 포함(보고서와 같은 규칙).
- API: `/api/meta`, `/api/runs`, `/api/runs/<id>`, `/api/runs/<id>/report`. 페이지는 `src/web/public/`의 정적 HTML/CSS/JS(빌드 단계 없음, CSP `default-src 'self'`, 에이전트 텍스트는 textContent로만 삽입).

## 알려진 한계 (v0.1)

- **익명성은 운영 규칙으로만 보장한다.** 같은 디렉터리를 공유하므로 심사위원이 `private/`을 읽는 것을 기술적으로 막지 않는다. 엄격한 블라인드 실험이 필요하면 다음 단계에서 PreToolUse 훅이나 별도 작업 디렉터리로 파일 접근을 분리한다.
- 익명화 검사는 본문에 에이전트 이름이 있는지 보는 경고 수준이다. 문체로 작성자를 추측하는 것은 막지 못한다.
- 재평가 점수 상승에는 피드백 효과와 같은 심사위원의 관대화가 섞일 수 있다. 단일 Claude 베이스라인과 비교 실험이 필요하다(README "연구 질문").
