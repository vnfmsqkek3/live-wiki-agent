terraform {
  required_version = ">= 1.14.0"
  backend "s3" {
    bucket       = "hanaeum-mvp-s3-tfstate"
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

# 데모 계정 공통 비밀번호: TF_VAR_demo_password (.env.local, git 제외). 사용자 지시 11/17: dev·prod 통일
variable "demo_password" {
  type      = string
  default   = null
  sensitive = true
}

module "stack" {
  source        = "../../stack"
  demo_password = var.demo_password
  env           = "prod"
  name_suffix   = ""
  owner         = "team"
  # prod 배포 직전 main 의 검증된 커밋으로 고정
  # dev 에서 smoke·실측을 통과한 커밋과 같게 (11/17 02시 기준). 바꿀 때는 dev 먼저 검증
  lambda_refs       = { yoyo0704 = "9244d28", dhxorb96 = "9fd2a05", let522mj = "dc1ba61" }
  ocr_source_ref    = "3310656"
  webapp_source_ref = "9fd2a05" # 웹·API (ECS·CloudFront)
  agents_source_ref = "9fd2a05" # 파이프라인 오케스트레이터·가이드 Runtime 이미지 (CodeBuild)
  team_lambdas = [
    "type-detection", "file-structure-check", "pii-scan", "injection-scan", "classify", "trust-gate", "wait-for-approval", "finalize",
    "text-layer-extract", "segment-build", "promote", "kb-ingest", "kb-chunker", "mcp-regulation", "mcp-search", "graph-upsert", "mcp-graph", "freshness-sweep", "image-describe", "explain-findings", "page-summarize", "interceptor", "mcp-privacy", "mcp-approval",
  ]
}

output "ssm_prefix" { value = module.stack.ssm_prefix }
output "demo_users_secret" { value = module.stack.demo_users_secret }
