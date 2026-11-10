# 연구 실행 프롬프트

개발 세션과 **다른** 새 Claude Code 대화형 세션을 이 폴더에서 열고(`claude`), 아래 블록의 `<주제>`와 `<제약>`을 바꿔 붙여 넣는다.
Agent Teams는 대화형 세션에서만 팀원을 만들 수 있다(`claude -p` 불가).

---

```text
IDEA ARENA 연구를 실행해줘. 너는 Team Lead다. CLAUDE.md의 "Team Lead 프로토콜"을 먼저 읽고 그대로 따라

주제: <한류 지속성 확보를 위한 전략 및 정책- 산업,국가,시기별 성장,정체,쇠퇴와 지속성 요인 진단-지속 가능한 발전을 위한 기업 전략,공공정책 제안>
제약:
- <마케팅 교수님 1명, 컴공 학생 1명이 팀이다>

1. 실행을 만든다:
   npm run arena -- create --topic "<주제>" --constraint "<제약>"
   npm run arena -- advance --run <id>

2. Agent Team을 만든다. 팀원 5명, 각자 정의 파일을 먼저 읽고 그 규칙을 따르게 한다:
   - creative     (Sonnet) — .claude/agents/creative.md
   - problem      (Sonnet) — .claude/agents/problem.md
   - business     (Sonnet) — .claude/agents/business.md
   - feasibility  (Opus)   — .claude/agents/feasibility-judge.md
   - innovation   (Opus)   — .claude/agents/innovation-judge.md

3. 단계마다: status 확인 → 담당 팀원에게 brief 출력을 그대로 전달 → 전원 완료 후 advance.
   전이가 중단되면 오류를 해당 팀원에게만 전달해 고치게 한다.

4. 지켜야 할 것:
   - 너는 아이디어를 쓰거나 점수를 매기지 않는다.
   - state.json과 오케스트레이터 산출물을 직접 만들거나 고치지 않는다. 상태 변경은 CLI로만.
   - 팀원에게 합의를 요구하지 않는다. 다른 팀원의 결론을 메시지로 옮기지 않는다.
   - 토론 1회, 개선 1회, 재평가 1회로 끝낸다.

5. COMPLETED가 되면 report를 출력하고 다음을 요약해줘:
   TOP 3와 선정 이유, 토론에서 점수가 바뀐 근거 유형(새 논거 / 동조 / 정정) 분포,
   토론 후에도 의견이 갈린 아이디어, 사람이 먼저 검증해야 할 가설.
   마지막으로 팀을 정리(cleanup)해.
```

---

## 실행 중 확인

```powershell
npm run arena -- list
npm run arena -- status --run <id>
npm run arena -- check  --run <id>     # 현재 단계 파일 검증만(상태 변경 없음)
npm run arena -- report --run <id>
```
