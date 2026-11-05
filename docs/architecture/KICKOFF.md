# 팀 시작 프롬프트

Claude Code를 이 폴더에서 새로 시작한 뒤, 아래 내용을 붙여넣고 `<만들 것>`만 바꾼다.

```text
<만들 것>을 만들 Agent Team을 구성해줘. 너는 Team Lead다.

팀원 3명을 정의된 agent type으로 생성해:
- frontend (frontend agent type, Sonnet)
- backend (backend agent type, Sonnet)
- qa (qa agent type, Opus)

CLAUDE.md의 팀 운영 규칙을 따라:
1. 먼저 docs/architecture/overview.md와 contracts/openapi.yaml을 작성하고 나에게 보여줘.
2. 내가 확인하면 공유 작업 목록에 작업을 의존성(blockedBy)과 함께 등록하고 팀원에게 배정해.
3. 의존성 없는 작업은 병렬로 진행하고, 팀원끼리 직접 메시지로 문제를 해결하게 해.
4. 너는 기능 코드를 직접 쓰지 말고 설계·분배·통합에 집중해.
5. 빌드와 테스트가 모두 끝나면 CLAUDE.md의 최종 보고 형식으로 보고해.
6. 커밋·병합·배포는 하지 말고 나에게 승인을 요청해.
```
