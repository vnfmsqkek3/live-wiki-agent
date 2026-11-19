#!/usr/bin/env bash
# Terraform S3 backend 버킷을 만든다. 여러 번 실행해도 결과가 같다.
# ponytail: State 버킷 하나뿐이라 Terraform 대신 CLI. 닭-달걀 문제(State 버킷의 State)를 피한다.
# 사용: set -a; . ./.env.local; set +a; hanaeum-terraform/bootstrap/tfstate.sh
# 팀 계정: TFSTATE_BUCKET=hanaeum-mvp-s3-tfstate-<계정ID> TFSTATE_WRITER_ROLE_ARN=arn:aws:iam::<계정ID>:role/team5-ide-yoyo0704 hanaeum-terraform/bootstrap/tfstate.sh
#   → State·잠금 파일 쓰기를 그 역할만 허용 (배포·인프라 수정은 yoyo0704 만, 사용자 지시 11/19)
set -euo pipefail
: "${HANAEUM_ACCOUNT_ID:?.env.local을 먼저 읽으세요}"
REGION=${AWS_REGION:-us-east-1}
BUCKET=${TFSTATE_BUCKET:-hanaeum-mvp-s3-tfstate}

ACTUAL=$(aws sts get-caller-identity --query Account --output text)
[ "$ACTUAL" = "$HANAEUM_ACCOUNT_ID" ] || { echo "계정 불일치: $ACTUAL != $HANAEUM_ACCOUNT_ID" >&2; exit 1; }

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  # us-east-1은 LocationConstraint를 넣으면 오류
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
fi
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
ONLY_WRITER=""
if [ -n "${TFSTATE_WRITER_ROLE_ARN:-}" ]; then
  ONLY_WRITER=",{\"Sid\":\"OnlyWriterRole\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":[\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::$BUCKET/*\",\"Condition\":{\"ArnNotEquals\":{\"aws:PrincipalArn\":\"$TFSTATE_WRITER_ROLE_ARN\"}}}"
fi
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"DenyInsecureTransport\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}$ONLY_WRITER]}"
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging 'TagSet=[{Key=Project,Value=hanaeum-mvp},{Key=Owner,Value=team}]'
echo "OK: s3://$BUCKET (versioning, SSE-KMS, public block, TLS only)"
