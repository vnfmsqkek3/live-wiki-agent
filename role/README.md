# role · 팀별 역할과 Orca 협업 규칙

에이전트 1개 = 팀 1개. 각 에이전트는 자기 팀 파일(`role/{팀명}.md`)과 이 파일만 읽고 시작한다.
`members/{닉네임}/`은 11/20 이전 기록 보관용이다 (읽기 전용).

## 1. 팀 목록과 소유 경로

| 팀 | slug (브랜치·리소스 이름) | 소유 경로 (직접 수정 가능) | 코드 리뷰 |
|---|---|---|---|
| [총괄팀](총괄팀.md) | `lead` | `docs/`, `role/`, `CLAUDE.md`, `README.md`, `.claude/` | — |
| [인프라팀](인프라팀.md) | `infra` | `hanaeum-terraform/`, `services/{ocr,convert-pdf,auth-triggers}/`, `workflows/`, `packages/db/`, `scripts/`, `observability/`, `tests/evaluations/runner/`, root 설정(`package.json`, `tsconfig.base.json`, `eslint.config.mjs`), `.github/workflows/` | 백엔드팀 |
| [백엔드팀](백엔드팀.md) | `backend` | `apps/api/`, `mcp/{approval-server,gateway-interceptor}/`, `tests/security/` | 인프라팀 |
| [프론트엔드팀](프론트엔드팀.md) | `frontend` | `apps/web/` | 프론트엔드QA팀 |
| [프론트엔드QA팀](프론트엔드QA팀.md) | `frontend-qa` | `tests/e2e/` | 프론트엔드팀 |
| [AI엔지니어팀](AI엔지니어팀.md) | `ai` | `agents/`, `packages/pii/`, `mcp/privacy-server/` | 백엔드팀 |
| [데이터엔지니어팀](데이터엔지니어팀.md) | `data` | `packages/{schemas,legal-parser,mcp-kit}/`, `services/{legal-etl,kb-chunker}/`, `mcp/{regulation,search,graph}-server/`, `tests/fixtures/` | 데이터QA팀 |
| [데이터QA팀](데이터QA팀.md) | `data-qa` | `tests/evaluations/cases/` | 데이터엔지니어팀 |
| [엔드유저팀](엔드유저팀.md) | `enduser` | 없음 (배포된 사이트만 사용) | — |

- 예외 (총괄팀 결정 11/20): `apps/api/src/steps/{pii,injection,classify,trust-gate,knowhow}.ts` 5개 파일은 AI엔지니어팀도 수정한다. 리뷰는 백엔드팀. 백엔드팀은 이 파일을 고치기 전에 AI엔지니어팀에 알린다.
- `docs/`는 초안이다 (사용자 결정 11/20). 실제로 해 보다가 비효율적이거나 바뀌어야 할 부분을 찾은 팀은 `docs/`의 해당 문서를 직접 고친다. 같은 PR에 코드와 함께 넣고, 문서 끝 또는 `interfaces.md` 변경 이력에 한 줄(날짜·팀·이유)을 남긴다. 영향받는 팀에 Orca로 알린다. 예외: `docs/02`(완료 판정·데모·정량 기준)는 총괄팀 리뷰를 받는다.
- 소유하지 않은 경로는 고치지 않는다. 고칠 일이 있으면 Owner 팀에 Orca로 요청한다 (2장).
- `package-lock.json`은 수정한 팀이 책임진다. 충돌이 나면 `npm install`로 다시 만든다.
- `docs/interfaces.md` 섹션 Owner는 위 표의 경로 Owner를 따른다. 변경하면 영향받는 팀에 Orca로 알린다.
- 14단계 담당: 0·2·10(API)·14 백엔드팀 / 6·7·8·9·오케스트레이터 AI엔지니어팀 / 3a·5·11·12·13 데이터엔지니어팀 / 1·2.5·3b·4·공통 에러 처리 인프라팀.

## 2. 협업은 Orca로만 한다

요청·회신·보고는 GitHub(파일 커밋, PR 코멘트, issue)로 하지 않는다. `요청기록/`·`공통기록/`에 새 파일을 만들지 않는다.

### 상대 팀 찾기

각 팀 에이전트의 Orca 탭 제목은 팀명이다 (`인프라팀` 등).

```bash
orca terminal list --include-visual-layouts --json   # tab title이 팀명인 terminal의 handle
```

총괄팀은 팀을 띄운 뒤 팀명·handle 명부를 전원에게 보낸다. 받은 명부는 `role/.state/{slug}.md`에 적어 둔다. Orca가 재시작되어 handle이 바뀌면 위 명령으로 다시 찾는다.

### 메시지 종류

| 상황 | 명령 |
|---|---|
| 수정·자료 요청, 질문 | `orca orchestration send --to <handle> --type question --subject "[요청] {요약}" --body "{내용, 기준 미달 근거, 완료 조건}" --json` |
| 작업 지시 (총괄팀) | `orca orchestration send --to <handle> --type dispatch --subject "{작업}" --body "{완료 조건}" --json` |
| 완료·진행·mock 보고 | `orca orchestration send --to <총괄팀 handle> --subject "[보고] {작업}" --body "{완료/진행/mock 여부, 증빙}" --json` (type 없음 = status) |
| PR 병합 준비 | `orca orchestration send --to <총괄팀 handle> --type merge_ready --subject "{브랜치}" --body "{PR 번호, 테스트 결과}" --json` |
| 작업 인계 | `--type handoff` |
| 받은 메시지 확인 | `orca orchestration check --json` |
| 회신 | `orca orchestration reply --id <message_id> --body "{처리 결과}" --json` |

- 세션을 시작할 때와 작업 단위를 하나 끝낼 때마다 `orca orchestration check`를 실행한다.
- 요청을 받으면 처리한 뒤 반드시 `reply`로 닫는다. 바로 못 하면 언제 할지를 회신한다.
- 메시지 본문에 secret, JWT, presigned URL, 원문 PII를 넣지 않는다.
- 다른 팀의 결과물을 기다리지 않는다. mock으로 진행하고, mock이라는 사실과 실연동이 필요하다는 점을 요청에 적는다.

## 3. 상태 보관

| 대상 | 위치 | Git |
|---|---|---|
| 팀 진행 상태·작업 계획·명부 | `role/.state/{slug}.md` | 올리지 않음 (`.gitignore`) |
| 세션이 바뀌어도 남아야 할 문제·해결 | `트러블슈팅.md` | 코드와 함께 PR |
| 역할·소유 경로·남은 일 | `role/{팀명}.md` | 총괄팀만 수정 |

### 컨텍스트 압축 (`/compact`)

컨텍스트가 길어지면 효율과 결과 품질이 떨어진다. 각 팀은 스스로 압축 시점을 판단한다 (사용자 지시 11/20).

1. 압축 전에 `role/.state/{slug}.md`를 갱신한다: 끝낸 작업(PR·커밋·증빙), 진행 중인 작업과 다음 단계, 기다리는 요청·회신(상대 팀·message id), 받은 결정, 팀 명부.
2. 총괄팀에 `[compact 준비] {팀명}`(type 없음)을 보낸다. `/compact`는 사용자 입력 명령이라 에이전트가 직접 실행할 수 없으므로, 총괄팀이 그 팀 터미널이 대기 상태이고 실행 중인 shell이 없을 때 `orca terminal send`로 `/compact`를 입력한다 (사용자 결정 11/20). 기준: 상태줄 `ctx` 60% 이상이거나 큰 작업 단위가 끝났을 때.
3. 압축 뒤 가장 먼저 `role/README.md` → `role/{팀명}.md` → `role/.state/{slug}.md`를 읽고, `orca orchestration check`로 새 메시지를 확인한 다음 이어서 한다.

## 4. Git

- 팀 브랜치는 `team/{slug}`이다. 각 팀은 자기 Orca worktree에서 작업한다. 엔드유저팀은 코드를 바꾸지 않으므로 총괄팀 worktree를 같이 써도 된다.
- 코드는 PR → 리뷰(1장 표) → CI 통과 → main 병합 순서를 따른다. 리뷰 요청도 Orca 메시지로 한다.
- 모든 팀이 같은 GitHub 계정이라 Approve가 안 된다. 리뷰 팀은 PR에 `[리뷰 승인] {팀명}` 코멘트를 남기고 작성 팀에 Orca로 회신한다. 이 둘이 있으면 리뷰 1팀으로 인정한다 (총괄팀 결정 11/20).
- `checkout -B`, `reset --hard`, force push를 쓰지 않는다. push한 브랜치는 rebase하지 않는다.
- 커밋 메시지 형식: `[{slug}] {영역}: {요약}`.
