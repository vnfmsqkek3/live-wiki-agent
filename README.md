# Living Wiki MVP · 하나이음(hanaeum) 5팀

금융기관 AI 지식 거버넌스 플랫폼. 합성 데이터만 사용한다.

## 시작하기

준비물: git, Node.js 최신 LTS, AWS CLI v2, Terraform, Docker(buildx), Claude Code. 확인은 `scripts/preflight.sh`.
로컬 PC라면 AWS profile(SSO 등)을 미리 로그인해 두고, 자료 조사용 Claude in Chrome 확장을 설치한다.

```bash
git clone https://github.com/vnfmsqkek3/live-wiki-agent.git
cd live-wiki-agent
claude
```

Claude Code에 본인 닉네임만 입력하면 환경 설정 → 브랜치 생성 → 계획 작성 → 구현까지 자동으로 진행한다 (`CLAUDE.md` "첫 실행").

| 이름 | 닉네임 | 담당 |
|---|---|---|
| 김동연 | yoyo0704 | 인프라·IaC·배포·관측 |
| 김민정 | let522mj | 데이터·검색 |
| 오태규 | dhxorb96 | Agent·앱 |

## 문서

`docs/README.md` 참고. 완료 기준은 `docs/02_mvp_dod_checklist.md`.
