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

## 11/17 (앞당겨 진행)

| No | 작업 | 완료 조건 | 의존 / mock | 상태 |
|---|---|---|---|---|
| 10 | DynamoDB Store | 메모리·공유 dev 계약 테스트 통과, 동시 승인 1건만 성공 | — | [x] |
| 11 | 단계 Lambda type-detection·2·9·10·14 | 단위 테스트 + 개인 dev 배포 | SFN 연결은 yoyo0704 | [m] 직접 호출로 검증 |
| 12 | 승인 E2E (공유 dev) | `tests/e2e/approval-flow-dev.sh` ALL PASS | 단계 6·7·8 미연결 | [x] |

## 11/19 (앞당겨 진행)

| No | 작업 | 완료 조건 | 의존 / mock | 상태 |
|---|---|---|---|---|
| 13 | 검색·가이드 Agent | 질의 PII 검사, 출처 검증, 불확실성 표시, 테스트 | search Tool(let522mj) mock | [m] 실모델 확인 |
| 14 | 화면 05·03 | 빌드·스크린샷 확인 | API mock | [m] |
| 15 | 분류 수정 API + 이력 | 테스트 | — | [x] |
| 16 | `mcp/privacy-server`, `mcp/approval-server` | 테스트 + Gateway 경유 호출, 승인·게시 Tool 미노출 | 공유 Gateway 등록은 yoyo0704 | [x] 개인 dev |

## 11/16 저녁 (갱신 22:43)

| No | 작업 | 완료 조건 | 의존 / mock | 상태 |
|---|---|---|---|---|
| 17 | 오케스트레이션 AgentCore 전환 (사용자 결정) | Strands Graph 오케스트레이터가 단계 Lambda를 Gateway Tool로 호출, 승인 후 resume, SFN 경로 제거 | yoyo0704 공유 Runtime·Gateway | [x] 공유 dev upload→PUBLISHED |
| 18 | 보안 테스트 재실행 | `tests/security` 7/7 | — | [x] |
| 19 | 노하우 검증 실제 Tool | TrustGate가 규정 저장소·KB 검색·Sonnet 사용, 정량 4/5 이상 | let522mj KB 색인 | [x] 5/5, 오탐 0/5 |
| 20 | AgentCore Memory | — | 사용자 결정 C안으로 철회 | [x] revert |
| 21 | 배포 산출물 | 웹·API Dockerfile, podman 빌드, 로컬 200 | yoyo0704 배포 | [x] 배포 대기 |
| 22 | 문서보관함 (사용자 결정) | 화면·API·요약·밑줄, 등록일 | let522mj buildMarks(PR #8 병합) | [x] 공유 dev K-002 밑줄 2곳 확인 |

## 남은 작업 (22:43 기준)

| 우선 | 작업 | 이유 |
|---|---|---|
| P0 | 게시된 노하우 자동 재검증 (규정 개정·시행일 도래 시 freshness=REVIEW_REQUIRED) + 화면 07 | Change Impact DoD. 지금은 탐지 Tool만 있고 게시 문서에 반영되지 않음 |
| P0 | 위조·인젝션·정상 문서 각 5건 정량 측정 | DoD 정량 |
| P0 | API 검색 연결 (`server.ts` search 임시 빈 결과) | 검색 화면·가이드 실데이터 |
| P0 | 가이드 Agent 공유 Runtime·실검색 | yoyo0704 Runtime 생성 후 |
| P1 | Wiki Maintenance 초안 생성 모델, Opus 고위험 검토, Guardrails 설정, 추천 | docs/01 9.1 대응표 |
| — | 실행 중인 AgentCore 이미지 podman 재빌드 | docker 라이선스 |

### 이전 메모

- yoyo0704가 단계 Lambda를 SFN에 연결하면 E2E에서 직접 호출 부분 제거
- PR #1 CI 수정 후 머지, PR #2 정리
- AgentCore Runtime 이미지 갱신(가이드 Agent) 후 Gateway search Tool 실연동
- Guardrails 출력 검사 (GUARDRAIL_ID 생성 후)
- 단계 6·7·8 Lambda (let522mj SegmentBuild 산출물 `work/segments/` 확정 후), Classify 실모델
- web `NEXT_PUBLIC_API_URL` 연결 (API 배포 위치 결정 후: ECS Fargate는 yoyo0704)
- Classify(단계 8) 실모델 호출 + structured output
- 개인 dev 실험 리소스 정리: `hanaeum-mvp-*-dhxorb96` (Cognito exp, Lambda gwstub·gwicpt, Gateway gw-exp, ECR agent, Runtime rt_exp, IAM role gwstub·gw·runtime)
