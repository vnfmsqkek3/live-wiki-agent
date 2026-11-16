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
  quarantine_bucket = module.s3.buckets["quarantine"]
  step_functions    = var.step_functions
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
  chunker_lambda_arn = var.kb_chunker_lambda_arn
  reader_role_arns   = var.kb_reader_role_arns
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
