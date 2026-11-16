locals {
  n = { prefix = "hanaeum-mvp", suffix = var.name_suffix }
}

module "network" {
  source = "../modules/network"
  n      = local.n
}

module "kms" {
  source = "../modules/kms"
  n      = local.n
}

module "s3" {
  source      = "../modules/s3"
  n           = local.n
  kms_key_arn = module.kms.key_arn
  # CloudFront 도메인(웹 배포 시) 자동 추가: 브라우저 presigned PUT
  web_origins = concat(var.web_origins, [for w in module.webapp : w.url])
}

module "ddb" {
  source              = "../modules/ddb"
  n                   = local.n
  kms_key_arn         = module.kms.key_arn
  deletion_protection = var.env == "prod"
}

# Lambda 패키지는 CodeBuild 가 구성 요소별 커밋으로 빌드해 S3 에 올린다 (로컬 빌드 금지, 11/16)
module "lambda_build" {
  source          = "../modules/lambda_build"
  n               = local.n
  kms_key_arn     = module.kms.key_arn
  artifact_bucket = module.s3.buckets["artifact"]
  refs            = var.lambda_refs
}

locals {
  lb      = module.lambda_build
  yoyo_s3 = { bucket = local.lb.bucket, prefix = local.lb.prefix["yoyo0704"] }
}

module "cognito" {
  source      = "../modules/cognito"
  n           = local.n
  kms_key_arn = module.kms.key_arn
  lambda_s3   = { bucket = local.yoyo_s3.bucket, key = "${local.yoyo_s3.prefix}/auth-triggers.zip" }
}

module "sfn" {
  source            = "../modules/sfn"
  n                 = local.n
  kms_key_arn       = module.kms.key_arn
  lambda_s3         = { bucket = local.yoyo_s3.bucket, key = "${local.yoyo_s3.prefix}/workflows.zip" }
  table_workflows   = module.ddb.tables["workflows"]
  table_documents   = module.ddb.tables["documents"]
  ocr_endpoint_name = module.ocr.endpoint_name
  quarantine_bucket = module.s3.buckets["quarantine"]
  step_functions    = merge(local.team_steps, local.lambda_arn)
}

module "kb" {
  source             = "../modules/kb"
  n                  = local.n
  kms_key_arn        = module.kms.key_arn
  index_lambda_s3    = { bucket = local.yoyo_s3.bucket, key = "${local.yoyo_s3.prefix}/workflows.zip" }
  published_bucket   = module.s3.buckets["published"]
  artifact_bucket    = module.s3.buckets["artifact"]
  embed_model_id     = var.models["MODEL_EMBED"]
  rerank_model_id    = var.models["MODEL_RERANK"]
  standby_replicas   = var.env == "prod" ? "ENABLED" : "DISABLED"
  chunker_lambda_arn = local.chunker_arn_var != null ? local.chunker_arn_var : try(module.kb_chunker[0].arn, null)
  reader_role_arns   = local.reader_roles
}

module "ocr" {
  source            = "../modules/ocr"
  source_ref        = coalesce(var.ocr_source_ref, var.lambda_refs["yoyo0704"]) # services/ocr 커밋 (바뀌면 이미지 재빌드·엔드포인트 교체)
  n                 = local.n
  kms_key_arn       = module.kms.key_arn
  quarantine_bucket = module.s3.buckets["quarantine"]
}

# 문서 처리 오케스트레이션: AgentCore Gateway(단계 Tool) + Runtime(오케스트레이터). 전환 완료 후 sfn 모듈 폐기
module "pipeline" {
  source                    = "../modules/agentcore_pipeline"
  n                         = local.n
  kms_key_arn               = module.kms.key_arn
  step_arns                 = module.sfn.step_arns
  tables                    = module.ddb.tables
  create_runtime            = local.agents_ref != null || var.pipeline_runtime_image_tag != null
  runtime_image_tag         = var.pipeline_runtime_image_tag != null ? var.pipeline_runtime_image_tag : terraform_data.agent_image["pipeline"].output
  runtime_env               = { BUCKET_QUARANTINE = module.s3.buckets["quarantine"].name, AWS_REGION = var.region, IMAGE_DESCRIBE = contains(var.team_lambdas, "image-describe") ? "on" : "off" }
  enable_transaction_search = var.enable_transaction_search
}

# 웹·API (ECS Fargate + ALB + CloudFront/WAF). webapp_source_ref 가 있으면 배포
module "webapp" {
  source               = "../modules/webapp"
  count                = var.webapp_source_ref == null ? 0 : 1
  n                    = local.n
  kms_key_arn          = module.kms.key_arn
  vpc_id               = module.network.vpc_id
  public_subnet_ids    = module.network.subnet_ids["public"]
  app_subnet_ids       = module.network.subnet_ids["app"]
  source_ref           = var.webapp_source_ref
  cognito_user_pool_id = module.cognito.user_pool_id
  cognito_client_id    = module.cognito.client_id
  tables               = module.ddb.tables
  quarantine_bucket    = module.s3.buckets["quarantine"]
  runtime_arn_patterns = [module.pipeline.runtime_arn_pattern, module.user.runtime_arn_pattern]
  extra_ecr_arns       = [module.pipeline.ecr_repository_arn, module.user.ecr_repository_arn]
  api_env = {
    PIPELINE_RUNTIME_ARN = module.pipeline.runtime_arn != null ? module.pipeline.runtime_arn : ""
    AGENT_RUNTIME_ARN    = module.user.runtime_arn
  }
}

# Agent 이미지 (agents/, dhxorb96): 웹과 같은 CodeBuild(podman)로 AWS 안에서 빌드. 태그 = 커밋
locals {
  agents_ref = var.webapp_source_ref == null ? null : coalesce(var.agents_source_ref, var.webapp_source_ref)
  # pipeline_runtime_image_tag 를 지정하면 그 태그를 그대로 쓰고 파이프라인 이미지는 빌드하지 않는다
  agent_images = local.agents_ref == null ? {} : merge(
    var.pipeline_runtime_image_tag != null ? {} : { pipeline = { dockerfile = "agents/Dockerfile.pipeline", repo = module.pipeline.ecr_repository_name } },
    { guide = { dockerfile = "agents/Dockerfile", repo = module.user.ecr_repository_name } },
  )
}

resource "terraform_data" "agent_image" {
  for_each         = local.agent_images
  input            = local.agents_ref                          # output = 이미지 태그 → Runtime 이 빌드 뒤에 갱신
  triggers_replace = [local.agents_ref, each.value.dockerfile] # input 변경만으로는 provisioner(빌드)가 다시 돌지 않는다
  provisioner "local-exec" {
    command = "${path.module}/../scripts/codebuild-wait.sh ${module.webapp[0].codebuild_project} APP=${each.key} REF=${local.agents_ref} ECR_REPO=${each.value.repo} DOCKERFILE=${each.value.dockerfile}"
  }
}

# 사용자 Gateway + 가이드 Runtime (docs/01 11장)
module "user" {
  source               = "../modules/agentcore_user"
  n                    = local.n
  kms_key_arn          = module.kms.key_arn
  cognito_user_pool_id = module.cognito.user_pool_id
  cognito_client_id    = module.cognito.client_id
  interceptor_arn      = module.team["interceptor"].arn
  schema_bucket        = { name = module.s3.buckets["artifact"].name, arn = module.s3.buckets["artifact"].arn }
  model_sonnet         = var.models["MODEL_SONNET"]
  create_runtime       = local.agents_ref != null
  image_tag            = local.agents_ref != null ? terraform_data.agent_image["guide"].output : null
  targets = {
    search     = { lambda_arn = module.team["mcp-search"].arn, tools_json = file("${path.module}/../../mcp/search-server/tools.json") }
    regulation = { lambda_arn = module.team["mcp-regulation"].arn, tools_json = file("${path.module}/../../mcp/regulation-server/tools.json") }
    graph      = { lambda_arn = module.team["mcp-graph"].arn, tools_json = file("${path.module}/../../mcp/graph-server/tools.json") }
    privacy    = { lambda_arn = module.team["mcp-privacy"].arn, tools_json = file("${path.module}/../../mcp/privacy-server/tools.json") }
    approval   = { lambda_arn = module.team["mcp-approval"].arn, tools_json = file("${path.module}/../../mcp/approval-server/tools.json") }
  }
}

# 조문·노하우 관계 그래프 (Change Impact)
module "neptune" {
  source          = "../modules/neptune"
  n               = local.n
  kms_key_arn     = module.kms.key_arn
  vpc_id          = module.network.vpc_id
  data_subnet_ids = module.network.subnet_ids["data"]
}

# 런타임 설정: SSM /hanaeum-mvp/{env}/{NAME} (interfaces.md 4장)
locals {
  params = merge(
    { for k, v in module.ddb.tables : "TABLE_${upper(k)}" => v.name },
    {
      BUCKET_QUARANTINE    = module.s3.buckets["quarantine"].name
      BUCKET_PUBLISHED     = module.s3.buckets["published"].name
      BUCKET_ARTIFACT      = module.s3.buckets["artifact"].name
      SQS_INGEST_TRIGGER   = module.sfn.trigger_queue_url
      COGNITO_USER_POOL_ID = module.cognito.user_pool_id
      COGNITO_CLIENT_ID    = module.cognito.client_id
      KMS_KEY_ARN          = module.kms.key_arn
      VPC_ID               = module.network.vpc_id
      KB_ID                = module.kb.kb_id
      NEPTUNE_ENDPOINT     = module.neptune.endpoint
      USER_GATEWAY_URL     = module.user.gateway_url
      GUARDRAIL_ID         = aws_bedrock_guardrail.pii.guardrail_id
      GUARDRAIL_VERSION    = aws_bedrock_guardrail_version.pii.version
      OCR_ENDPOINT_NAME    = module.ocr.endpoint_name
      PIPELINE_GATEWAY_URL = module.pipeline.gateway_url
      PIPELINE_ECR_REPO    = module.pipeline.ecr_repository_url
      PIPELINE_RUNTIME_ARN = module.pipeline.runtime_arn != null ? module.pipeline.runtime_arn : "pending"
      KB_DS_LEGAL_ID       = module.kb.data_source_ids["legal"]
      KB_DS_KNOWLEDGE_ID   = module.kb.data_source_ids["knowledge"]
    },
    var.models,
  )
}

resource "aws_ssm_parameter" "p" {
  for_each = local.params
  name     = "/hanaeum-mvp/${var.env}/${each.key}"
  type     = "String"
  value    = each.value
}

output "ssm_prefix" { value = "/hanaeum-mvp/${var.env}/" }
output "web_url" { value = try(module.webapp[0].url, null) }
output "demo_users_secret" { value = module.cognito.demo_users_secret }
output "network" { value = module.network }
