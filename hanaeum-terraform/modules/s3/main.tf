# 버킷 4종 (interfaces.md 3장). quarantine(원본 등급)·published(정제본) 분리 (docs/03 ①).
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "web_origins" { type = list(string) }

locals {
  # 서버 접근 로그 대상 버킷은 SSE-KMS 를 쓸 수 없어 log 만 SSE-S3
  buckets = {
    quarantine = { kms = true, versioning = true }
    published  = { kms = true, versioning = true }
    artifact   = { kms = true, versioning = false }
    log        = { kms = false, versioning = false }
  }
  # 모델을 호출하는 Role 은 태그 hanaeum-model-caller=true 를 단다 → 원본 등급 키 읽기 거부
  original_grade_keys = ["*/original.*", "*/work/*", "_ocr-async/*"]
}

resource "aws_s3_bucket" "b" {
  for_each      = local.buckets
  bucket        = "${var.n.prefix}-s3-${each.key}${var.n.suffix}"
  force_destroy = var.n.suffix != "" # prod 만 보호
}

resource "aws_s3_bucket_public_access_block" "b" {
  for_each                = aws_s3_bucket.b
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = local.buckets[each.key].kms ? "aws:kms" : "AES256"
      kms_master_key_id = local.buckets[each.key].kms ? var.kms_key_arn : null
    }
    bucket_key_enabled = local.buckets[each.key].kms
  }
}

# 승인 바인딩이 s3_version_id 를 쓰므로 quarantine·published 는 버전관리 필수 (interfaces.md 7.1)
resource "aws_s3_bucket_versioning" "b" {
  for_each = { for k, v in local.buckets : k => v if v.versioning }
  bucket   = aws_s3_bucket.b[each.key].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_logging" "b" {
  for_each      = { for k, v in aws_s3_bucket.b : k => v if k != "log" }
  bucket        = each.value.id
  target_bucket = aws_s3_bucket.b["log"].id
  target_prefix = "${each.key}/"
}

resource "aws_s3_bucket_lifecycle_configuration" "log" {
  bucket = aws_s3_bucket.b["log"].id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = 90 }
  }
}

# 브라우저 presigned PUT 업로드 (dhxorb96 요청 11/16). 웹 도메인은 CloudFront 생성 후 web_origins 에 추가
resource "aws_s3_bucket_cors_configuration" "quarantine" {
  bucket = aws_s3_bucket.b["quarantine"].id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.web_origins
    allowed_headers = ["content-type", "content-length", "x-amz-*"]
    max_age_seconds = 600
  }
}

# 업로드 이벤트 → EventBridge (sfn 모듈의 규칙이 SQS 로 보냄)
resource "aws_s3_bucket_notification" "quarantine" {
  bucket      = aws_s3_bucket.b["quarantine"].id
  eventbridge = true
}

data "aws_iam_policy_document" "b" {
  for_each = aws_s3_bucket.b
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  dynamic "statement" {
    for_each = each.key == "quarantine" ? [1] : []
    content {
      sid       = "DenyModelCallerOnOriginalGrade"
      effect    = "Deny"
      actions   = ["s3:GetObject", "s3:GetObjectVersion"]
      resources = [for k in local.original_grade_keys : "${each.value.arn}/${k}"]
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:PrincipalTag/hanaeum-model-caller"
        values   = ["true"]
      }
    }
  }
  dynamic "statement" {
    for_each = each.key == "log" ? [1] : []
    content {
      sid       = "S3ServerAccessLogs"
      effect    = "Allow"
      actions   = ["s3:PutObject"]
      resources = ["${each.value.arn}/*"]
      principals {
        type        = "Service"
        identifiers = ["logging.s3.amazonaws.com"]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "b" {
  for_each   = aws_s3_bucket.b
  bucket     = each.value.id
  policy     = data.aws_iam_policy_document.b[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.b]
}

output "buckets" {
  value = { for k, v in aws_s3_bucket.b : k => { name = v.id, arn = v.arn } }
}

# ---------- 단계 1 MalwareCheck: GuardDuty Malware Protection for S3 (quarantine) ----------
# 스캔 결과는 객체 태그 GuardDutyMalwareScanStatus 로 남는다 → workflows/src/steps/malware-check.ts 가 읽음.
data "aws_caller_identity" "me" {}
data "aws_region" "this" {}

resource "aws_iam_role" "guardduty" {
  name = "${var.n.prefix}-role-gd-malware${var.n.suffix}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "malware-protection-plan.guardduty.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.me.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "guardduty" {
  role = aws_iam_role.guardduty.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EventBridgeManagedRule"
        Effect    = "Allow"
        Action    = ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets"]
        Resource  = "arn:aws:events:${data.aws_region.this.region}:${data.aws_caller_identity.me.account_id}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*"
        Condition = { StringLike = { "events:ManagedBy" = "malware-protection-plan.guardduty.amazonaws.com" } }
      },
      {
        Sid      = "EventBridgeDescribe"
        Effect   = "Allow"
        Action   = ["events:DescribeRule", "events:ListTargetsByRule"]
        Resource = "arn:aws:events:${data.aws_region.this.region}:${data.aws_caller_identity.me.account_id}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*"
      },
      {
        Sid      = "BucketNotification"
        Effect   = "Allow"
        Action   = ["s3:PutBucketNotification", "s3:GetBucketNotification", "s3:ListBucket"]
        Resource = aws_s3_bucket.b["quarantine"].arn
      },
      {
        Sid      = "ValidationObject"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.b["quarantine"].arn}/malware-protection-resource-validation-object"
      },
      {
        Sid      = "ScanAndTag"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectTagging", "s3:GetObjectVersionTagging", "s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
        Resource = "${aws_s3_bucket.b["quarantine"].arn}/*"
      },
      {
        Sid       = "Kms"
        Effect    = "Allow"
        Action    = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource  = var.kms_key_arn
        Condition = { StringLike = { "kms:ViaService" = "s3.*.amazonaws.com" } }
      },
    ]
  })
}

resource "aws_guardduty_malware_protection_plan" "quarantine" {
  role = aws_iam_role.guardduty.arn
  protected_resource {
    s3_bucket { bucket_name = aws_s3_bucket.b["quarantine"].id }
  }
  actions {
    tagging { status = "ENABLED" }
  }
  depends_on = [aws_iam_role_policy.guardduty, aws_s3_bucket_notification.quarantine]
}
