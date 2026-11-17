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

# 데모 계정 공통 비밀번호: TF_VAR_demo_password (.env.local, git 제외)
variable "demo_password" {
  type      = string
  default   = null
  sensitive = true
}

module "stack" {
  source        = "../../stack"
  demo_password = var.demo_password
  env           = "dev"
  # 거버넌스 저장소 (사용자 결정 11/17, interfaces.md 10장): 13시 전환
  governance_store = "postgres"
  name_suffix      = "-dev"
  owner            = "team"

  # 공유 dev 는 개인 dev 자원을 참조하지 않는다 (사용자 지시 11/16, 요청기록 2242, docs/06).
  # 팀원 Lambda 도 prod 처럼 CodeBuild 가 lambda_refs 커밋으로 빌드한 공유 이름 hanaeum-mvp-lambda-*-dev
  team_lambdas = [
    "type-detection", "file-structure-check", "pii-scan", "injection-scan", "classify", "trust-gate", "wait-for-approval", "finalize",
    "text-layer-extract", "segment-build", "promote", "kb-ingest", "kb-chunker", "mcp-regulation", "mcp-search", "graph-upsert", "mcp-graph", "freshness-sweep", "image-describe", "explain-findings", "page-summarize", "purge-document", "interceptor", "mcp-privacy", "mcp-approval",
  ]
  lambda_refs = {
    yoyo0704 = "1f07fa6" # workflows·auth-triggers·services/ocr
    dhxorb96 = "6fab736" # apps/api 단계 Lambda (CI·smoke 확인, dhxorb96)
    let522mj = "d2b2639" # PR #26 전부 OCR(document.pdf 있을 때 모든 쪽) (+#24 이전)
  }

  ocr_source_ref = "25f42de" # PP-StructureV3 표·레이아웃 + figures (11/17)

  # AgentCore 오케스트레이터 (dhxorb96 agents/src/pipeline, 긴급 전환 11/16). 태그가 있으면 Runtime 생성 → type-detection 이 AgentCore 로 시작
  # null: webapp_source_ref 커밋으로 오케스트레이터 이미지를 CodeBuild 빌드. 지정하면 그 태그 고정(빌드 안 함)
  pipeline_runtime_image_tag = null
  enable_transaction_search  = true

  # 웹·API (dhxorb96 요청 웹API배포, 사용자 결정 ECS Fargate). dhxorb96 이 podman 빌드로 확인한 커밋
  webapp_source_ref = "8d25284" # 실패 사유 설명(explanation)·쪽 위치·차단 사유
  agents_source_ref = "8d25284" # 파이프라인·가이드 이미지 (웹과 분리: 재게시 중 오케스트레이터 고정)
}

output "ssm_prefix" { value = module.stack.ssm_prefix }
output "demo_users_secret" { value = module.stack.demo_users_secret }
output "web_url" { value = module.stack.web_url }
