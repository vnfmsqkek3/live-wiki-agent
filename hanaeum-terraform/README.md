# hanaeum-terraform

최종 IaC (Owner yoyo0704). `stack/`이 리소스 구성, `envs/{dev,prod}`는 backend·이름 접미사만 다르다.

| 경로 | 내용 |
|---|---|
| `bootstrap/tfstate.sh` | State 버킷 생성 (최초 1회, 재실행 안전) |
| `stack/` | 모듈 조합 + SSM 출력 |
| `modules/*` | network, kms, s3, ddb, cognito, sfn |
| `envs/dev` | 공유 dev (`-dev` 접미사, `Owner=team`) |
| `envs/prod` | 최종 (접미사 없음, `Owner=team`) |

```bash
set -a; . ./.env.local; set +a
npm run package -w workflows        # Lambda 번들 (linux arm64 의존성 포함, workflows/.lambda)
npm run build -w services/auth-triggers
terraform -chdir=hanaeum-terraform/envs/dev init
terraform -chdir=hanaeum-terraform/envs/dev apply
```

개인 테스트 환경이 필요하면 `envs/dev`를 복사해 `name_suffix = "-{닉네임}"`, backend key `{닉네임}/terraform.tfstate`로 바꾼다.
