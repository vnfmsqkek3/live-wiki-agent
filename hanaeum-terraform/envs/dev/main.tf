terraform {
  required_version = ">= 1.14.0"
  backend "s3" {
    bucket       = "hanaeum-mvp-s3-tfstate"
    key          = "dev/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

module "stack" {
  source      = "../../stack"
  env         = "dev"
  name_suffix = "-dev"
  owner       = "team"

  # 공유 dev 는 개인 dev 자원을 참조하지 않는다 (사용자 지시 11/16, 요청기록 2242, docs/06).
  # 팀원 Lambda 도 prod 처럼 CodeBuild 가 lambda_refs 커밋으로 빌드한 공유 이름 hanaeum-mvp-lambda-*-dev
  team_lambdas = [
    "type-detection", "file-structure-check", "pii-scan", "injection-scan", "classify", "trust-gate", "wait-for-approval", "finalize",
    "text-layer-extract", "segment-build", "promote", "kb-ingest", "kb-chunker", "mcp-regulation", "mcp-search", "graph-upsert", "mcp-graph", "freshness-sweep", "image-describe", "interceptor", "mcp-privacy", "mcp-approval",
  ]
  lambda_refs = {
    yoyo0704 = "78d8355"                                  # workflows·auth-triggers·services/ocr
    dhxorb96 = "e812aac"                                  # apps/api 단계 Lambda (CI·smoke 확인, dhxorb96)
    let522mj = "812a58933071d59bad6f7f0f30e948c2780b5114" # PR #9 병합 (하나은행 전환·DOCX·HWPX·OCR 보정)
  }

  ocr_source_ref = "3310656" # services/ocr 변경 없음. 엔드포인트 유지

  # AgentCore 오케스트레이터 (dhxorb96 agents/src/pipeline, 긴급 전환 11/16). 태그가 있으면 Runtime 생성 → type-detection 이 AgentCore 로 시작
  pipeline_runtime_image_tag = "d0eeeae" # agents 이미지 빌드가 없을 때만 (webapp_source_ref 가 있으면 그 커밋으로 빌드)
  enable_transaction_search  = true

  # 웹·API (dhxorb96 요청 웹API배포, 사용자 결정 ECS Fargate). dhxorb96 이 podman 빌드로 확인한 커밋
  webapp_source_ref = "32e5f81"
}

output "ssm_prefix" { value = module.stack.ssm_prefix }
output "demo_users_secret" { value = module.stack.demo_users_secret }
output "web_url" { value = module.stack.web_url }
