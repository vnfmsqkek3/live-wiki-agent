# plan · dhxorb96 (오태규)

> TODO.md 기준 작업 단위. 완료 판정은 `docs/02`. 상태: `[ ]` 대기 · `[~]` 진행 · `[x]` 완료 · `[m]` mock으로 완료(실연동 필요)

## 11/16 · M0

| No | 작업 | 완료 조건 | 의존 / mock | 상태 |
|---|---|---|---|---|
| 1 | 환경 설정 | `.env.local` 생성, 계정 ID가 `HANAEUM_ACCOUNT_ID`와 일치, 브랜치 `dhxorb96` | — | [x] |
| 2 | 버전 결정 | `interfaces.md` 8장 dhxorb96 행 기입, lockfile 고정 | — | [x] |
| 3 | npm workspace 골격 | root `package.json`(workspaces)·`tsconfig.base.json` | root는 yoyo0704 소유 → 임시 생성 + 요청기록 | [x] |
| 4 | `apps/api` 골격 | Cognito JWT 검증, RBAC, 공통 오류 `{error:{code,message,trace_id}}`, 테스트 통과 | Cognito 없음 → verifier 주입(테스트) | [m] 실 Cognito access token 검증 확인 |
| 5 | 업로드 URL·type-detection·FileStructureCheck | SigV4·리전 엔드포인트 presign, 매직바이트 판정, A-002(PNG 메타데이터) 차단 테스트 | S3 버킷 없음 → presign은 로컬 생성만 | [m] |
| 6 | 승인 API + 승인 바인딩 | 재사용·자기 승인·해시 불일치·중복 결정 거부 테스트 | DynamoDB 없음 → 메모리 저장소 | [m] |
| 7 | 단계 6·7·9 규칙 엔진 | PII(주민번호 체크섬·전화·이메일·계좌) 마스킹, Injection 규칙, TrustGate 판정 테스트 | Guardrails·Registry → stub | [m] |
| 8 | AgentCore 연결 실험 | Runtime `/ping`·`/invocations` 200, 모델 1회 호출, Gateway `tools/list`·`tools/call` 성공 → `interfaces.md` 9장 | 개인 dev 리소스 직접 생성 | [x] 모델은 Sonnet 4.6 대체 |
| 9 | `apps/web` 골격 | 로그인·하단 탭 4개·업로드(04) 화면, 모바일·데스크톱 렌더 확인 | API mock | [m] 01·02·04·06·로그인, 500px·1280px 확인 (390px는 수동 확인 필요) |

## 이후 (TODO.md 11/17~)

- 11/17: 실제 Cognito·S3 연동 (yoyo0704 공유 dev 배포 후)
- 11/18: Classify 실모델, 승인 task token(SendTaskSuccess), 화면 05·01·02, E2E 1건
- 11/19: 검색·가이드 Agent, `mcp/privacy-server`·`mcp/approval-server`, 화면 TrustGate·03

## 남은 작업 (11/17 시작 시)

- 공유 dev(yoyo0704) 배포 후: DynamoDB Store 구현, S3 presign 실버킷, SFN 연결, web `NEXT_PUBLIC_API_URL`
- 단계 Lambda 핸들러 래퍼 (S3 읽기·Documents 갱신·task token 저장) — 규칙 엔진은 완료
- Classify(단계 8) 실모델 호출 + structured output
- 개인 dev 실험 리소스 정리: `hanaeum-mvp-*-dhxorb96` (Cognito exp, Lambda gwstub·gwicpt, Gateway gw-exp, ECR agent, Runtime rt_exp, IAM role gwstub·gw·runtime)
