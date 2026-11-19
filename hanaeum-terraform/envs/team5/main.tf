# 팀 계정 배포 환경 (사용자 지시 11/19)
# - 배포·인프라 수정은 yoyo0704 만: yoyo0704 EC2 Instance Profile(team5-ide-yoyo0704)이 아니면 plan 단계에서 멈춘다
# - 자격증명은 EC2 Instance Profile (AWS_PROFILE 없이 실행)
# - State 버킷: bootstrap/tfstate.sh 를 TFSTATE_BUCKET·TFSTATE_WRITER_ROLE_ARN 으로 실행해 만든다 (쓰기는 yoyo0704 역할만)
# - VPC: modules/network 기본 10.40.0.0/16. 팀 계정 기존 team5-vpc 10.5.0.0/16 과 겹치지 않아 그대로 둔다
terraform {
  required_version = ">= 1.14.0"
  backend "s3" {
    # bucket 은 backend.hcl (git 제외, 계정 ID 포함): terraform init -backend-config=backend.hcl
    key          = "team5/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" { region = "us-east-1" }

data "aws_caller_identity" "me" {}

resource "terraform_data" "only_yoyo0704" {
  lifecycle {
    precondition {
      condition     = can(regex(":assumed-role/team5-ide-yoyo0704/", data.aws_caller_identity.me.arn))
      error_message = "팀 계정 terraform 배포·인프라 수정은 yoyo0704 EC2(Instance Profile team5-ide-yoyo0704)에서만 합니다. 다른 사람은 요청기록/으로 요청하세요."
    }
  }
}

variable "demo_password" {
  type      = string
  default   = null
  sensitive = true
}

module "stack" {
  source        = "../../stack"
  demo_password = var.demo_password
  env           = "prod"
  owner         = "team"
  # S3 버킷 이름은 전 세계에서 하나: 기존 prod 계정 버킷(hanaeum-mvp-s3-*)과 겹치지 않게 접미사
  name_suffix       = "-team5"
  governance_store  = "postgres"
  ocr_min_instances = 1 # ml.g4dn.xlarge endpoint 한도 4 (11/19 확인)
  protect_data      = false
  # Claude 5.5 (사용자 지시 11/19). 코드는 d4cb22d 부터 5.5 호환
  models = {
    MODEL_HAIKU  = "us.anthropic.claude-haiku-5-5"
    MODEL_SONNET = "us.anthropic.claude-sonnet-5-5"
    MODEL_OPUS   = "us.anthropic.claude-opus-4-6-v1"
    MODEL_EMBED  = "amazon.titan-embed-text-v2:0"
    MODEL_RERANK = "cohere.rerank-v3-5:0"
  }
  lambda_refs               = { yoyo0704 = "d4cb22d", dhxorb96 = "d4cb22d", let522mj = "d4cb22d" }
  ocr_source_ref            = "620108a"
  webapp_source_ref         = "d4cb22d"
  agents_source_ref         = "d4cb22d"
  enable_transaction_search = true
  team_lambdas = [
    "type-detection", "file-structure-check", "pii-scan", "injection-scan", "classify", "trust-gate", "wait-for-approval", "finalize",
    "text-layer-extract", "segment-build", "promote", "kb-ingest", "kb-chunker", "mcp-regulation", "mcp-search", "graph-upsert", "mcp-graph", "freshness-sweep", "image-describe", "explain-findings", "page-summarize", "purge-document", "category-sweep", "reference-check", "interceptor", "mcp-privacy", "mcp-approval",
  ]
}

output "ssm_prefix" { value = module.stack.ssm_prefix }
output "demo_users_secret" { value = module.stack.demo_users_secret }
output "mcp_external_secret" { value = module.stack.mcp_external_secret }
output "web_url" { value = module.stack.web_url }
