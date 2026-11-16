# 테이블 7종. 키는 모두 pk/sk(S) + gsi1(gsi1pk/gsi1sk). 키 값 규칙은 각 테이블 Owner 가 정한다 (interfaces.md 4장).
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "deletion_protection" { type = bool }

locals {
  tables = ["documents", "regulations", "findings", "approvals", "feedback", "audit_events", "workflows"]
}

resource "aws_dynamodb_table" "t" {
  for_each                    = toset(local.tables)
  name                        = "${var.n.prefix}-ddb-${replace(each.key, "_", "-")}${var.n.suffix}"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }
  global_secondary_index {
    name            = "gsi1"
    projection_type = "ALL"
    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }
  point_in_time_recovery { enabled = true }
  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }
}

output "tables" {
  value = { for k, v in aws_dynamodb_table.t : k => { name = v.name, arn = v.arn } }
}
