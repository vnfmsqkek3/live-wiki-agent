#!/usr/bin/env bash
# let522mj 개인 dev Lambda 배포 (공유 dev 리소스 사용, 이름 접미사 -let522mj). 다시 실행해도 같은 결과 (생성 또는 갱신).
# 최종(공유) 배포는 yoyo0704가 Terraform으로 한다. 이 스크립트는 연동 확인용.
# 사용: services/legal-etl/scripts/deploy-dev-let522mj.sh   (먼저 node services/legal-etl/scripts/build-lambdas.ts)
set -euo pipefail
cd "$(dirname "$0")/../../.."
set -a; . ./.env.local; set +a
ACC=$(aws sts get-caller-identity --query Account --output text)
[ "$ACC" = "$HANAEUM_ACCOUNT_ID" ] || { echo "계정 불일치: $ACC" >&2; exit 1; }
R=us-east-1; NICK=let522mj; ENV=dev
ssm() { aws ssm get-parameter --name "/hanaeum-mvp/$ENV/$1" --query Parameter.Value --output text; }
KMS=$(ssm KMS_KEY_ARN); KB_ID=$(ssm KB_ID)
TD=$(ssm TABLE_DOCUMENTS); TA=$(ssm TABLE_APPROVALS); TR=$(ssm TABLE_REGULATIONS)
BQ=$(ssm BUCKET_QUARANTINE); BP=$(ssm BUCKET_PUBLISHED); BA=$(ssm BUCKET_ARTIFACT)
DDB="arn:aws:dynamodb:$R:$ACC:table"; KB_ARN="arn:aws:bedrock:$R:$ACC:knowledge-base/$KB_ID"
TAGS="Key=Project,Value=hanaeum-mvp Key=Owner,Value=$NICK"

role() { # 이름 정책JSON [추가태그]
  local name="hanaeum-mvp-role-$1-$NICK"
  if ! aws iam get-role --role-name "$name" >/dev/null 2>&1; then
    aws iam create-role --role-name "$name" --tags $TAGS ${3:-} \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    aws iam attach-role-policy --role-name "$name" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  fi
  aws iam put-role-policy --role-name "$name" --policy-name inline --policy-document "$2"
  echo "arn:aws:iam::$ACC:role/$name"
}

# 1) 파이프라인 단계 (원본 등급 읽음 → 모델 호출 Role 아님)
STEPS_ROLE=$(role steps "$(cat <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::$BQ"},
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":"arn:aws:s3:::$BQ/*"},
 {"Effect":"Allow","Action":["s3:PutObject"],"Resource":["arn:aws:s3:::$BP/legal/*","arn:aws:s3:::$BP/knowledge/*"]},
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":"arn:aws:s3:::$BA/kb-ingest/*"},
 {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::$BA","Condition":{"StringLike":{"s3:prefix":"kb-ingest/*"}}},
 {"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:UpdateItem"],"Resource":"$DDB/$TD"},
 {"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:UpdateItem","dynamodb:Query"],"Resource":["$DDB/$TA","$DDB/$TA/index/gsi1"]},
 {"Effect":"Allow","Action":["bedrock:StartIngestionJob","bedrock:GetIngestionJob"],"Resource":"$KB_ARN"},
 {"Effect":"Allow","Action":["kms:Decrypt","kms:GenerateDataKey"],"Resource":"$KMS"}]}
EOF
)")
# 2) KB Custom Transformation (KB가 호출, 중간 저장소만)
CHUNK_ROLE=$(role kbchunker "$(cat <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":"arn:aws:s3:::$BA/kb-intermediate/*"},
 {"Effect":"Allow","Action":["kms:Decrypt","kms:GenerateDataKey"],"Resource":"$KMS"}]}
EOF
)")
# 3) MCP Tool (게시본·조문만 읽음, 모델 호출 Role → 원본 읽기 거부 태그)
MCP_ROLE=$(role mcp "$(cat <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["dynamodb:Query"],"Resource":"$DDB/$TR"},
 {"Effect":"Allow","Action":["dynamodb:BatchGetItem"],"Resource":"$DDB/$TD"},
 {"Effect":"Allow","Action":["bedrock:Retrieve"],"Resource":"$KB_ARN"},
 {"Effect":"Allow","Action":["bedrock:Rerank","bedrock:InvokeModel"],"Resource":["arn:aws:bedrock:$R::foundation-model/cohere.rerank-v3-5:0","arn:aws:bedrock:$R::foundation-model/amazon.titan-embed-text-v2:0"]},
 {"Effect":"Allow","Action":["bedrock-agentcore:StartBrowserSession","bedrock-agentcore:StopBrowserSession","bedrock-agentcore:GetBrowserSession","bedrock-agentcore:ConnectBrowserAutomationStream"],"Resource":"arn:aws:bedrock-agentcore:$R:aws:browser/aws.browser.v1"},
 {"Effect":"Allow","Action":["kms:Decrypt"],"Resource":"$KMS"}]}
EOF
)" "Key=hanaeum-model-caller,Value=true")
sleep 10 # IAM 전파

fn() { # 용도 zip이름 Role 메모리 타임아웃 env(JSON)
  local name="hanaeum-mvp-lambda-$1-$NICK" zip="dist/lambda/$2.zip"
  if aws lambda get-function --function-name "$name" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$name" --zip-file "fileb://$zip" >/dev/null
    aws lambda wait function-updated --function-name "$name"
    aws lambda update-function-configuration --function-name "$name" --role "$3" --memory-size "$4" --timeout "$5" --environment "Variables=$6" >/dev/null
  else
    aws lambda create-function --function-name "$name" --runtime nodejs24.x --architectures arm64 --handler index.handler \
      --role "$3" --memory-size "$4" --timeout "$5" --environment "Variables=$6" --zip-file "fileb://$zip" \
      --tags "Project=hanaeum-mvp,Owner=$NICK" >/dev/null
  fi
  aws lambda wait function-updated --function-name "$name" 2>/dev/null || aws lambda wait function-active-v2 --function-name "$name"
  echo "$1 arn:aws:lambda:$R:$ACC:function:$name"
}

fn text-layer-extract text_layer_extract "$STEPS_ROLE" 1024 120 "{}"
fn segment-build segment_build "$STEPS_ROLE" 512 60 "{}"
fn promote promote "$STEPS_ROLE" 512 60 "{BUCKET_PUBLISHED=$BP,TABLE_DOCUMENTS=$TD,TABLE_APPROVALS=$TA}"
fn kb-ingest kb_ingest "$STEPS_ROLE" 256 30 "{KB_ID=$KB_ID,KB_DS_LEGAL_ID=$(ssm KB_DS_LEGAL_ID),KB_DS_KNOWLEDGE_ID=$(ssm KB_DS_KNOWLEDGE_ID),BUCKET_ARTIFACT=$BA,TABLE_DOCUMENTS=$TD,TABLE_APPROVALS=$TA}"
fn kb-chunker kb_chunker "$CHUNK_ROLE" 1024 300 "{}"
fn mcp-regulation mcp_regulation "$MCP_ROLE" 512 90 "{TABLE_REGULATIONS=$TR}"
fn mcp-search mcp_search "$MCP_ROLE" 512 30 "{KB_ID=$KB_ID,MODEL_RERANK=$(ssm MODEL_RERANK),TABLE_DOCUMENTS=$TD,TABLE_REGULATIONS=$TR}"
echo "roles: steps=$STEPS_ROLE kbchunker=$CHUNK_ROLE mcp=$MCP_ROLE"
# graph_upsert·mcp_graph는 Neptune(11/20) 배포 후 VPC 설정과 함께 추가
