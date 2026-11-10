# IDEA ARENA — Autonomous Idea Lab (v0.1)

주제 하나를 넣으면 Claude 에이전트 5명이 아이디어를 **독립 생성 → 익명 심사 → 교차 토론 → 개선 → 재평가**하고, TOP 3와 그 근거를 보고서로 남기는 로컬 연구 도구.

- 생성자 3명(Creative / Problem / Business, Sonnet)이 각 2개씩, 총 6개 아이디어
- 심사위원 2명(Feasibility / Innovation, Opus)이 익명화된 6개를 독립 채점
- 의견이 갈린 아이디어만 1회 토론 → 생성자가 1회 개선 → 1회 재평가
- 결과: `runs/<id>/final/report.md` — 순위, 점수 변화(최초→토론 후→최종), 실패 가능성, 검증할 가설, 반박·개선 과정, 주 단위 MVP 계획

Claude Code Agent Teams(실험 기능)를 대화형 세션에서 쓰는 구조라 별도 API 키나 과금이 필요 없다.

## 설치

```powershell
claude --version          # 없으면: irm https://claude.ai/install.ps1 | iex
npm install
npm run check             # 타입 검사 + 테스트
```

`.claude/settings.json`이 이 프로젝트에서 Agent Teams(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`)와 `in-process` 표시 모드를 켠다.

## 연구 실행

1. 이 폴더에서 새 세션을 연다: `claude`
2. [docs/EXECUTION_PROMPT.md](docs/EXECUTION_PROMPT.md)의 프롬프트에 주제를 넣어 붙여 넣는다.
3. Team Lead가 팀을 만들고 단계마다 CLI로 검증·전이하며 진행한다.

## 결과 대시보드 (로컬 웹)

```powershell
npm run dashboard                 # http://127.0.0.1:4173  (다른 포트: npm run dashboard -- --port 5000)
```
`runs/`의 파일을 그대로 읽어서 보여주는 **읽기 전용** 페이지다. 클라우드·DB 없이 이 컴퓨터에서만 열린다.

- 실행 목록, 진행 단계, 이 단계에서 기다리는 파일
- 최종 순위와 점수 흐름(최초 → 토론 후 → 최종), 심사 격차·이견 표시
- 아이디어별 원본/개선본 비교, 항목별 점수(1차·토론 후·재평가), 심사 의견, 토론 기록, MVP 계획
- 오케스트레이션 지표, 실행 기록
- 진행 중인 실행은 4초마다 자동 갱신. 작성자(생성 관점)는 연구가 완료된 뒤에만 표시된다.

## CLI

```powershell
npm run arena -- create  --topic "대학생 생활 문제 해결" --constraint "2~3명, 4주 MVP"
npm run arena -- list
npm run arena -- status  --run <id>        # 단계, 담당, 필요한 파일 ✓/✗, 최근 이벤트
npm run arena -- brief   --run <id> --agent creative   # 팀원에게 보낼 작업 지시
npm run arena -- check   --run <id>        # 검증만
npm run arena -- advance --run <id>        # 검증 후 전이
npm run arena -- retry   --run <id> [--force]
npm run arena -- report  --run <id>
npm run arena -- serve   [--port 4173]     # = npm run dashboard
```
종료 코드: 0 성공 · 1 전이 중단(파일 누락/오류) · 2 사용법 오류 · 3 실패.

## 구조

자세한 상태 머신, 파일 레이아웃, 점수 규칙은 [docs/architecture.md](docs/architecture.md). Team Lead 운영 규칙은 [CLAUDE.md](CLAUDE.md).

```
src/domain/         스키마(Zod), 점수 산정, 상태 전이 — 순수 로직
src/orchestration/  단계 핸들러, 익명화, 검증, 원자적 저장, 작업 지시
src/reports/        순위·보고서
src/cli/            CLI
src/web/            로컬 대시보드 서버(node:http) + public/ 정적 페이지(빌드 없음)
.claude/agents/     에이전트 5명 정의
tests/              단위 + 전체 실행(e2e) 테스트
runs/               실행 데이터 (Git 제외)
```

## 연구 질문

> 여러 에이전트가 독립 생성하고 반박하는 방식이, 단일 AI가 생성한 아이디어보다 실제로 더 나은 결과를 만드는가?

v0.1은 비교에 필요한 데이터(최초·토론 후·최종 점수, 점수 변경 근거 유형, 심사 격차 변화, 생성 관점별 성적)를 모두 남긴다. 다음 단계에서 같은 주제로 단일 Claude 베이스라인(6개 생성·평가)을 실행하고, 같은 기준으로 품질·다양성·검증 가능성·비용을 비교한다. AI 심사위원 점수만으로 개선을 단정하지 말고 사람 평가자를 함께 쓴다.

## 로드맵

- **v0.1** CLI 연구소 (현재)
- **v0.2** 대시보드 — 로컬 읽기 전용 웹 대시보드로 구현됨(`npm run dashboard`)
- **v0.3** Claude API 기반 실행 엔진 — 웹 UI에서 실행 (API 인증·과금 필요)
- **v1.0** 평가 실험 플랫폼 — 가중치 실험, 심사위원 편향 분석, 사람 vs AI 평가 비교
