# 팀 운영 규칙

이 프로젝트는 Claude Code Agent Team으로 개발한다. 모든 팀원(lead 포함)은 이 규칙을 따른다.

## 팀 구성

| 역할 | 이름 | 모델 | 정의 파일 | 책임 |
|---|---|---|---|---|
| Team Lead | lead (메인 세션) | Opus | 이 파일 | 아키텍처, 작업 분해·분배, 의존성 관리, 통합 |
| Frontend | `frontend` | Sonnet | `.claude/agents/frontend.md` | React/TypeScript 구현 |
| Backend | `backend` | Sonnet | `.claude/agents/backend.md` | Spring Boot/API/DB 구현 |
| QA | `qa` | Opus | `.claude/agents/qa.md` | 코드 리뷰, 테스트, 보안 검증 |

## 파일 소유권 (같은 파일 동시 수정 금지)

| 경로 | 소유자 | 비고 |
|---|---|---|
| `CLAUDE.md`, `.claude/**`, 루트 설정 파일 | lead | |
| `docs/architecture/**` | lead | 설계 문서, ADR |
| `contracts/openapi.yaml` | lead | FE/BE 공용 API 계약. 변경은 lead에게 요청 |
| `frontend/**` | frontend | |
| `backend/**` | backend | |
| `e2e/**`, `docs/qa/**` | qa | |

- 소유하지 않은 파일은 읽기만 한다. 수정이 필요하면 소유자에게 메시지로 요청한다.
- 소유권이 애매한 새 파일은 만들기 전에 lead에게 묻는다.

## Lead 작업 순서

Lead는 직접 기능 코드를 쓰지 않는다. 설계, 계약, 분배, 통합 검증에 집중한다.

1. **설계**: 요구사항을 `docs/architecture/overview.md`에 정리(도메인 모델, 화면 목록, 엔드포인트 목록, 비기능 요구).
2. **계약 확정**: `contracts/openapi.yaml` 작성. FE와 BE는 이 계약만 보고 병렬로 일한다.
3. **작업 분해**: 공유 작업 목록에 작업을 등록한다. 작업마다 담당자, 산출물, 완료 조건(실행할 명령), 선행 작업(blockedBy)을 적는다.
4. **병렬 실행**: 의존성이 없는 작업은 동시에 맡긴다. 기본 흐름:
   ```
   T1 설계+계약 (lead)
     ├─ T2 백엔드 스캐폴딩 (backend) ─ T4 백엔드 기능 ─┐
     ├─ T3 프론트 스캐폴딩 (frontend) ─ T5 프론트 기능(mock) ─┤
     └─ T6 E2E 시나리오 초안 (qa) ─────────────────────────┤
                                       T7 FE↔BE 연동 (frontend) ┤
                                       T8 리뷰+보안 점검 (qa) ──┤
                                       T9 통합 빌드·테스트 (qa) → T10 결과 보고 (lead)
   ```
5. **통합**: 팀원 보고를 받아 계약 불일치, 누락, 충돌을 정리하고 필요한 작업을 추가 등록한다.
6. **보고**: 테스트와 빌드가 모두 끝나면 사용자에게 결과를 보고한다(아래 형식).

## 소통 규칙

- 팀원끼리 직접 메시지로 문제를 해결한다. lead를 거치지 않아도 된다.
  - FE ↔ BE: 응답 형식, 에러 코드, CORS, 인증 헤더
  - QA → FE/BE: 결함 보고(파일:라인, 재현, 기대 결과, 심각도)
- 계약 변경, 소유권 분쟁, 작업 범위 변경만 lead에게 올린다.
- 막히면 오래 기다리지 말고 상황과 필요한 것을 메시지로 알린다.

## 완료 조건

| 영역 | 명령 |
|---|---|
| Backend | `.\gradlew.bat build` (테스트 포함) |
| Frontend | `npm run lint` · `npm run typecheck` · `npm test -- --run` · `npm run build` |
| E2E | `npx playwright test` |

명령이 실패한 작업은 completed로 바꾸지 않는다.

## 사용자 승인이 필요한 작업

다음은 **반드시 사용자 승인을 받는다**. 팀원은 실행하지 않고 lead에게 요청한다.
- `git commit`, `git push`, `git merge`, `git rebase`, 브랜치 삭제
- 배포(Docker 레지스트리 push, 클라우드 배포, Vercel 등)
- 운영 DB 접속·변경

## 최종 보고 형식

```
## 결과
- 구현: (기능 목록)
- 빌드: backend ✅/❌ · frontend ✅/❌
- 테스트: backend N/N · frontend N/N · e2e N/N
- 보안 점검: 발견 N건 (해결 N / 남음 N, 심각도 표시)
- 미확인 항목: ...
- 승인 요청: 커밋/병합/배포 여부
```

## 기술 스택 기본값

- Backend: Java 21, Spring Boot 3.x, Gradle Wrapper, Spring Data JPA, Flyway, H2(개발)/PostgreSQL(운영)
- Frontend: Node 22+, Vite, React 18+, TypeScript strict, Vitest, Testing Library, ESLint
- E2E: Playwright
- 로컬 환경: Windows 11, PowerShell (Gradle/Maven 전역 설치 없음 → Gradle Wrapper 사용)
