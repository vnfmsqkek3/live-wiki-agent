# Bedrock KB 1개 + OpenSearch Serverless 벡터 인덱스 1개 + 데이터 소스 2개 (docs/04 4.1).
# 데이터 소스는 published 버킷만 (docs/03 ②). Quarantine 은 KB 에 절대 연결하지 않는다.
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "published_bucket" { type = object({ name = string, arn = string }) }
variable "artifact_bucket" { type = object({ name = string, arn = string }) }
variable "embed_model_id" { type = string }
variable "rerank_model_id" { type = string }
variable "standby_replicas" { type = string } # dev DISABLED, prod ENABLED
# let522mj 의 Custom Transformation Lambda. null 이면 청킹 없이(NONE) 파일 1개 = 청크 1개.
variable "chunker_lambda_arn" {
  type    = string
  default = null
}
# KB 를 직접 Retrieve 하는 Role (search MCP Tool Lambda 등). AOSS 데이터 접근 정책에 추가.
variable "reader_role_arns" {
  type    = list(string)
  default = []
}

data "aws_region" "this" {}
data "aws_caller_identity" "me" {}
data "aws_iam_session_context" "me" { arn = data.aws_caller_identity.me.arn }

locals {
  coll  = "${var.n.prefix}-aoss-kb${var.n.suffix}"
  index = "hanaeum-kb-wiki"
}

# ---------- OpenSearch Serverless ----------
resource "aws_opensearchserverless_security_policy" "enc" {
  name = "${local.coll}-enc"
  type = "encryption"
  policy = jsonencode({
    Rules       = [{ ResourceType = "collection", Resource = ["collection/${local.coll}"] }]
    KmsARN      = var.kms_key_arn
    AWSOwnedKey = false
  })
}

# ponytail: 공개 엔드포인트 + IAM(SigV4) 인증. 인덱스 생성을 로컬에서 하기 위함.
# 은행 이관 시 AOSS VPC Endpoint + SourceServices(bedrock) 로 전환 (docs/01 15장).
resource "aws_opensearchserverless_security_policy" "net" {
  name = "${local.coll}-net"
  type = "network"
  policy = jsonencode([{
    Rules = [
      { ResourceType = "collection", Resource = ["collection/${local.coll}"] },
      { ResourceType = "dashboard", Resource = ["collection/${local.coll}"] },
    ]
    AllowFromPublic = true
  }])
}

resource "aws_opensearchserverless_collection" "kb" {
  name             = local.coll
  type             = "VECTORSEARCH"
  standby_replicas = var.standby_replicas
  depends_on       = [aws_opensearchserverless_security_policy.enc, aws_opensearchserverless_security_policy.net]
}

resource "aws_opensearchserverless_access_policy" "data" {
  name = "${local.coll}-data"
  type = "data"
  policy = jsonencode([{
    Rules = [
      { ResourceType = "collection", Resource = ["collection/${local.coll}"], Permission = ["aoss:DescribeCollectionItems", "aoss:CreateCollectionItems", "aoss:UpdateCollectionItems"] },
      { ResourceType = "index", Resource = ["index/${local.coll}/*"], Permission = ["aoss:CreateIndex", "aoss:DeleteIndex", "aoss:DescribeIndex", "aoss:ReadDocument", "aoss:WriteDocument", "aoss:UpdateIndex"] },
    ]
    Principal = distinct(concat([aws_iam_role.kb.arn, data.aws_iam_session_context.me.issuer_arn], var.reader_role_arns))
  }])
}

resource "terraform_data" "index" {
  triggers_replace = [aws_opensearchserverless_collection.kb.id, local.index]
  provisioner "local-exec" {
    command = "node ${path.module}/../../scripts/aoss-index.mjs ${aws_opensearchserverless_collection.kb.collection_endpoint} ${local.index} ${path.module}/index-mapping.json"
  }
  depends_on = [aws_opensearchserverless_access_policy.data]
}

# ---------- KB 실행 Role ----------
resource "aws_iam_role" "kb" {
  name = "${var.n.prefix}-role-kb${var.n.suffix}"
  tags = { "hanaeum-model-caller" = "true" } # quarantine 원본 등급 읽기 거부 (s3 모듈)
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.me.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:bedrock:${data.aws_region.this.region}:${data.aws_caller_identity.me.account_id}:knowledge-base/*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "kb" {
  role = aws_iam_role.kb.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      { Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = "arn:aws:bedrock:${data.aws_region.this.region}::foundation-model/${var.embed_model_id}" },
      # Retrieve 의 rerankingConfiguration 은 KB Role 로 실행된다
      { Effect = "Allow", Action = ["bedrock:Rerank"], Resource = "*" },
      { Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = "arn:aws:bedrock:${data.aws_region.this.region}::foundation-model/${var.rerank_model_id}" },
      { Effect = "Allow", Action = ["aoss:APIAccessAll"], Resource = aws_opensearchserverless_collection.kb.arn },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = var.published_bucket.arn },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${var.published_bucket.arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = var.artifact_bucket.arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${var.artifact_bucket.arn}/kb-intermediate/*" },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
      ], var.chunker_lambda_arn == null ? [] : [
      { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = [var.chunker_lambda_arn, "${var.chunker_lambda_arn}:*"] },
    ])
  })
}

# ---------- Knowledge Base ----------
resource "aws_bedrockagent_knowledge_base" "kb" {
  name     = "${var.n.prefix}-kb-wiki${var.n.suffix}"
  role_arn = aws_iam_role.kb.arn
  knowledge_base_configuration {
    type = "VECTOR"
    vector_knowledge_base_configuration {
      embedding_model_arn = "arn:aws:bedrock:${data.aws_region.this.region}::foundation-model/${var.embed_model_id}"
      embedding_model_configuration {
        bedrock_embedding_model_configuration {
          dimensions          = 1024
          embedding_data_type = "FLOAT32"
        }
      }
    }
  }
  storage_configuration {
    type = "OPENSEARCH_SERVERLESS"
    opensearch_serverless_configuration {
      collection_arn    = aws_opensearchserverless_collection.kb.arn
      vector_index_name = local.index
      field_mapping {
        vector_field   = "embedding"
        text_field     = "text"
        metadata_field = "bedrock_metadata"
      }
    }
  }
  depends_on = [terraform_data.index, aws_iam_role_policy.kb]
}

resource "aws_bedrockagent_data_source" "ds" {
  for_each             = toset(["legal", "knowledge"])
  name                 = "${var.n.prefix}-kbds-${each.key}${var.n.suffix}"
  knowledge_base_id    = aws_bedrockagent_knowledge_base.kb.id
  data_deletion_policy = "DELETE"
  data_source_configuration {
    type = "S3"
    s3_configuration {
      bucket_arn         = var.published_bucket.arn
      inclusion_prefixes = ["${each.key}/"]
    }
  }
  vector_ingestion_configuration {
    chunking_configuration { chunking_strategy = "NONE" }
    dynamic "custom_transformation_configuration" {
      for_each = var.chunker_lambda_arn == null ? [] : [1]
      content {
        intermediate_storage {
          s3_location { uri = "s3://${var.artifact_bucket.name}/kb-intermediate/" }
        }
        transformation {
          step_to_apply = "POST_CHUNKING"
          transformation_function {
            transformation_lambda_configuration { lambda_arn = var.chunker_lambda_arn }
          }
        }
      }
    }
  }
}

output "kb_id" { value = aws_bedrockagent_knowledge_base.kb.id }
output "data_source_ids" { value = { for k, v in aws_bedrockagent_data_source.ds : k => v.data_source_id } }
output "kb_role_arn" { value = aws_iam_role.kb.arn }
