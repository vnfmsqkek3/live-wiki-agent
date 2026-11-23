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
  # 거버넌스 저장소 PostgreSQL (사용자 결정 11/17, interfaces.md 10장). prod 는 시험 문서뿐이라 복사 없이 빈 상태로 시작
  governance_store  = "postgres"
  ocr_min_instances = 1 # 사용자 결정 11/18 21시: prod 단일 환경, OCR 최소 1·최대 1 (max 는 모듈 기본 1)
  name_suffix       = ""
  protect_data      = false # 사용자 결정 11/18: 시험 단계라 데이터 날아가도 됨, destroy→재배포 시험
  owner             = "team"
  # 사용자 결정 11/18 21시: dev 폐기, prod 단일 환경. 팀원 배포 요청은 여기 커밋을 올려 바로 apply (11/18 dev 끝까지 시험 36/36 통과 커밋)
  lambda_refs               = { yoyo0704 = "24094c2", dhxorb96 = "f736830", let522mj = "a133799" }
  ocr_source_ref            = "620108a"
  webapp_source_ref         = "a133799" # 웹·API (ECS·CloudFront)
  agents_source_ref         = "2ffd23b" # 파이프라인 오케스트레이터·가이드 Runtime 이미지 (CodeBuild)
  pipeline_runtime_image_tag = "24094c2" # ponytail: 9차는 가이드만(agents/src/guide.ts). 파이프라인 24094c2 고정, 다음 파이프라인 변경 배포 때 이 줄 삭제
  enable_transaction_search = true      # 계정 단위 자원 (dev destroy 11/18 23:22 뒤 prod 가 보유)
  team_lambdas = [
    "type-detection", "file-structure-check", "pii-scan", "injection-scan", "classify", "trust-gate", "wait-for-approval", "finalize",
    "text-layer-extract", "segment-build", "promote", "kb-ingest", "kb-chunker", "mcp-regulation", "mcp-search", "graph-upsert", "mcp-graph", "freshness-sweep", "image-describe", "explain-findings", "page-summarize", "purge-document", "category-sweep", "reference-check", "interceptor", "mcp-privacy", "mcp-approval",
  ]
}

output "ssm_prefix" { value = module.stack.ssm_prefix }
output "demo_users_secret" { value = module.stack.demo_users_secret }
output "mcp_external_secret" { value = module.stack.mcp_external_secret }
output "web_url" { value = module.stack.web_url }
