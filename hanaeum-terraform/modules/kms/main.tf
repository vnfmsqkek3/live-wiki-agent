variable "n" { type = object({ prefix = string, suffix = string }) }

data "aws_caller_identity" "me" {}
data "aws_region" "this" {}

resource "aws_kms_key" "data" {
  description             = "hanaeum-mvp data (S3 quarantine/published/artifact, DynamoDB, SSM, logs)"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.me.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${data.aws_region.this.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${data.aws_region.this.region}:${data.aws_caller_identity.me.account_id}:*" } }
      },
    ]
  })
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.n.prefix}-kms-data${var.n.suffix}"
  target_key_id = aws_kms_key.data.key_id
}

output "key_arn" { value = aws_kms_key.data.arn }
