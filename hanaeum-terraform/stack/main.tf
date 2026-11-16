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
  runtime_image_tag         = var.pipeline_runtime_image_tag
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
  runtime_arn_patterns = [module.pipeline.runtime_arn_pattern]
  api_env = {
    PIPELINE_RUNTIME_ARN = module.pipeline.runtime_arn != null ? module.pipeline.runtime_arn : ""
    AGENT_RUNTIME_ARN    = "" # 공유 가이드 Agent Runtime 생성 후
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
