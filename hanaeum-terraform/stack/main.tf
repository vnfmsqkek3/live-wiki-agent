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
  web_origins = var.web_origins
}

module "ddb" {
  source              = "../modules/ddb"
  n                   = local.n
  kms_key_arn         = module.kms.key_arn
  deletion_protection = var.env == "prod"
}

module "cognito" {
  source      = "../modules/cognito"
  n           = local.n
  kms_key_arn = module.kms.key_arn
}

module "sfn" {
  source            = "../modules/sfn"
  n                 = local.n
  kms_key_arn       = module.kms.key_arn
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
  n                 = local.n
  kms_key_arn       = module.kms.key_arn
  quarantine_bucket = module.s3.buckets["quarantine"]
  artifact_bucket   = module.s3.buckets["artifact"]
}

# 문서 처리 오케스트레이션: AgentCore Gateway(단계 Tool) + Runtime(오케스트레이터). 전환 완료 후 sfn 모듈 폐기
module "pipeline" {
  source        = "../modules/agentcore_pipeline"
  n             = local.n
  kms_key_arn   = module.kms.key_arn
  step_arns     = module.sfn.step_arns
  tables        = module.ddb.tables
  runtime_image = var.pipeline_runtime_image
  runtime_env   = { BUCKET_QUARANTINE = module.s3.buckets["quarantine"].name, AWS_REGION_NAME = var.region }
}

# 런타임 설정: SSM /hanaeum-mvp/{env}/{NAME} (interfaces.md 4장)
locals {
  params = merge(
    { for k, v in module.ddb.tables : "TABLE_${upper(k)}" => v.name },
    {
      BUCKET_QUARANTINE    = module.s3.buckets["quarantine"].name
      BUCKET_PUBLISHED     = module.s3.buckets["published"].name
      BUCKET_ARTIFACT      = module.s3.buckets["artifact"].name
      SFN_INGEST_ARN       = module.sfn.state_machine_arn
      SQS_INGEST_TRIGGER   = module.sfn.trigger_queue_url
      COGNITO_USER_POOL_ID = module.cognito.user_pool_id
      COGNITO_CLIENT_ID    = module.cognito.client_id
      KMS_KEY_ARN          = module.kms.key_arn
      VPC_ID               = module.network.vpc_id
      KB_ID                = module.kb.kb_id
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
output "demo_users_secret" { value = module.cognito.demo_users_secret }
output "network" { value = module.network }
