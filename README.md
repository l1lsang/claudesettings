# IDEA ARENA — Autonomous Idea Lab

주제 하나를 넣으면 GPT 에이전트 5명이 아이디어를 **독립 생성 → 익명 심사 → 교차 토론 → 개선 → 재평가**하고, TOP 3와 그 근거를 보고서로 남기는 연구 도구.
Claude Code 없이 **OpenAI 호환 API 키(Letsur 게이트웨이)** 하나로 돌아가고, **Vercel**에 올려 비밀번호로 잠근 웹 앱으로 쓴다.

- 생성자 3명이 각 2개씩, 총 6개 아이디어 → 심사위원 2명이 익명화된 6개를 독립 채점
- 의견이 갈린 아이디어만 1회 토론 → 생성자가 1회 개선 → 1회 재평가
- 결과: 순위, 점수 변화(최초→토론 후→최종), 실패 가능성, 검증할 가설, 반박·개선 과정, 단계별 실행 계획

## 상황 프리셋

창업 아이디어만이 아니라 상황에 맞춰 생성 관점·심사위원·평가 기준·가중치·계획 단위가 바뀐다.

| 프리셋 | 쓰는 곳 | 생성 관점 | 심사위원 |
|---|---|---|---|
| `general` 범용 (기본) | 생활, 학습, 커뮤니티, 개인 프로젝트, 섞인 주제 | 발산 / 사람 중심 / 실용 | 회의론자 / 비전가 |
| `product` 서비스·창업 | 제품, 앱, 스타트업, 기능 | 창의 / 문제 중심 / 비즈니스 | 실현 가능성 / 혁신성 |
| `research` 연구 | 연구 질문, 논문·학위 주제, 실험 | 개척 / 임팩트 / 엄밀성 | 방법론 / 분야 전문가 |
| `marketing` 마케팅·캠페인 | 캠페인, 콘텐츠, 브랜드, 그로스 | 파격 / 인사이트 / 그로스 | 퍼포먼스 / 브랜드 전략 |
| `strategy` 전략·정책 | 사업 전략, 의사결정, 공공정책, 조직 개선 | 급진 / 이해관계자 / 실행가 | 리스크 / 임팩트 |
| `creative` 창작·콘텐츠 | 이야기, 게임, 행사, 공연, 이름 | 파격 / 관객 / 완성도 | 프로듀서 / 비평가 |

정의: [src/domain/presets.ts](src/domain/presets.ts). 내부 구조(슬롯·파일·점수 계산)는 같고 이름·관점·기준만 바뀐다.

## 구성

```
브라우저 (src/web/public)                       Vercel 함수 /api (src/web/vercel.ts)
 ├─ 로그인(비밀번호)                              ├─ APP_PASSWORD 확인 → HttpOnly 세션 쿠키
 ├─ 실행 데이터 보관: IndexedDB  ── files ──▶   ├─ 임시 디렉터리에 실행 파일을 펼치고 오케스트레이터 실행
 └─ 단계 진행: 에이전트 병렬 호출 → advance      └─ 에이전트 작업: GPT 호출(LETSUR_API_KEY) → 검증 → 실패 시 재작성
```

- **서버에 DB가 없다.** 실행 데이터는 브라우저(IndexedDB)에 저장되고, 화면의 "실행 내보내기"로 JSON 백업, "가져오기"로 복원한다. 다른 기기와 공유·동기화가 필요해지면 그때 Firebase를 붙인다.
- API 키는 서버(Vercel 환경 변수)에만 있고 브라우저로 나가지 않는다.
- 각 에이전트는 자기가 볼 수 있는 데이터만 프롬프트로 받는다(심사위원은 익명 아이디어만, 생성자는 자기 피드백만). 정보 격리가 코드로 보장된다.
- 에이전트 작업 하나 = 함수 호출 하나(최대 300초). 진행 중에는 탭을 열어 둔다. 닫았다가 다시 열면 "이어서 진행"으로 남은 작업부터 재개한다.

## Vercel 배포

1. Vercel에 이 저장소(또는 폴더)를 프로젝트로 연결한다. 설정은 [vercel.json](vercel.json)에 있다(빌드: `npm run build` → `.vercel/output`).
2. 프로젝트 **Settings → Environment Variables**에 추가:

   | 이름 | 값 | 필수 |
   |---|---|---|
   | `APP_PASSWORD` | 웹 앱 로그인 비밀번호 | ✓ |
   | `LETSUR_API_KEY` | platform.letsur.ai에서 받은 키 | ✓ |
   | `ARENA_MODEL` | 모든 에이전트 모델 (기본 `gpt-6.1-sol`) | |
   | `ARENA_GENERATOR_MODEL` / `ARENA_JUDGE_MODEL` | 생성자·심사위원 모델을 따로 지정 | |
   | `LETSUR_BASE_URL` | 기본 `https://gw.letsur.ai/v1` (다른 OpenAI 호환 게이트웨이도 가능) | |

3. 환경 변수를 바꾼 뒤에는 **Redeploy**해야 적용된다. 비밀번호를 바꾸면 기존 로그인 세션은 모두 끊긴다.

## 로컬 실행

```powershell
npm install
npm run check                 # 타입 검사 + 테스트
npm run dev                   # http://127.0.0.1:4173 — Vercel과 같은 화면·API
```

`.env`(Git 제외)에 `LETSUR_API_KEY=...`, `APP_PASSWORD=...`를 둔다.

### CLI (터미널에서 끝까지 자동 실행)

```powershell
npm run arena -- presets
npm run arena -- auto --topic "한류 지속성 확보 전략" --constraint "교수 1명, 학생 1명" --preset strategy
npm run arena -- report --run <id>
npm run arena -- export --run <id> > run.json      # 웹 화면의 "가져오기"로 열 수 있음
```

결과는 `runs/<id>/`(Git 제외)에 남는다. 수동 진행용 명령(`create`, `status`, `brief`, `check`, `advance`, `retry`)도 그대로 있다. 종료 코드: 0 성공 · 1 전이 중단 · 2 사용법 오류 · 3 실패.

## 구조

자세한 상태 머신, 파일 레이아웃, 점수 규칙은 [docs/architecture.md](docs/architecture.md).

```
src/domain/         스키마(Zod), 점수, 상태 전이, 상황 프리셋 — 순수 로직
src/engine/         OpenAI 호환 클라이언트(llm.ts), 에이전트 프롬프트(prompts.ts)
src/orchestration/  단계 핸들러, 익명화, 검증, 저장, 에이전트 작업(agent-tasks.ts), 자동 진행(autopilot.ts)
src/reports/        순위·보고서
src/cli/            CLI
src/web/            API(api.ts), 로그인(auth.ts), 임시 작업 공간(workspace.ts), 로컬 서버, Vercel 진입점, public/ 화면
scripts/            Vercel 빌드(build-vercel.mjs)
tests/              단위 + 전체 실행(가짜 모델) 테스트
```

## 연구 질문

> 여러 에이전트가 독립 생성하고 반박하는 방식이, 단일 AI가 생성한 아이디어보다 실제로 더 나은 결과를 만드는가?

비교에 필요한 데이터(최초·토론 후·최종 점수, 점수 변경 근거 유형, 심사 격차 변화, 생성 관점별 성적)를 모두 남긴다. AI 심사위원 점수만으로 개선을 단정하지 말고 사람 평가자를 함께 쓴다.
