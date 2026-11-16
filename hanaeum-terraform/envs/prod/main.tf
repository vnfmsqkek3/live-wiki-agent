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

module "stack" {
  source      = "../../stack"
  env         = "prod"
  name_suffix = ""
  owner       = "team"
  # prod 배포 직전 main 의 검증된 커밋으로 고정
  # dev 에서 smoke·실측을 통과한 커밋과 같게 (11/17 02시 기준). 바꿀 때는 dev 먼저 검증
  lambda_refs       = { yoyo0704 = "2443244", dhxorb96 = "ff8b69e", let522mj = "b580e7e" }
  ocr_source_ref    = "3310656"
  webapp_source_ref = "ff8b69e" # 웹·API (ECS·CloudFront)
  agents_source_ref = "ff8b69e" # 파이프라인 오케스트레이터·가이드 Runtime 이미지 (CodeBuild)
  team_lambdas = [
    "type-detection", "file-structure-check", "pii-scan", "injection-scan", "classify", "trust-gate", "wait-for-approval", "finalize",
    "text-layer-extract", "segment-build", "promote", "kb-ingest", "kb-chunker", "mcp-regulation", "mcp-search", "graph-upsert", "mcp-graph", "freshness-sweep", "image-describe", "explain-findings", "interceptor", "mcp-privacy", "mcp-approval",
  ]
}

output "ssm_prefix" { value = module.stack.ssm_prefix }
output "demo_users_secret" { value = module.stack.demo_users_secret }
