# 문서 처리 단계 배선 (Owner yoyo0704). 모듈 이름은 이력상 sfn 이지만 Step Functions 는 폐기됨 (11/16, AgentCore 전환).
# S3(quarantine) ObjectCreated → EventBridge → SQS trigger(+DLQ) → type-detection(dhxorb96) → AgentCore Runtime(agentcore_pipeline)
# 이 모듈: 업로드 트리거 큐, yoyo0704 단계 Lambda(MalwareCheck·PageRender·OcrIfNeeded), stub(미배포 단계용), 단계 ARN 맵
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "table_workflows" { type = object({ name = string, arn = string }) }
variable "table_documents" { type = object({ name = string, arn = string }) }
variable "quarantine_bucket" { type = object({ name = string, arn = string }) }
variable "step_functions" { type = map(string) }
variable "ocr_endpoint_name" { type = string }
variable "lambda_dist" {
  type    = string
  default = "../../../workflows/.lambda" # npm run package -w workflows
}

locals {
  name = "${var.n.prefix}-sfn-ingest${var.n.suffix}"
  steps = [
    "malware_check", "file_structure_check", "text_layer_extract", "page_render", "ocr_if_needed",
    "segment_build", "pii_scan", "injection_scan", "classify", "trust_gate", "wait_for_approval",
    "promote", "kb_ingest", "graph_upsert", "finalize",
  ]
  # yoyo0704 소유 단계 Lambda (workflows/src/steps)
  own_steps = {
    malware_check = { handler = "steps/malware-check.handler", timeout = 30, memory = 256 }
    page_render   = { handler = "steps/page-render.handler", timeout = 300, memory = 2048 }
    ocr_if_needed = { handler = "steps/ocr-if-needed.handler", timeout = 60, memory = 256 }
  }
  # 우선순위: 변수(다른 Owner Lambda) > 내 단계 > stub(mock)
  step_arns = merge(
    { for s in local.steps : s => aws_lambda_function.fn["stub-step"].arn },
    { for k, v in aws_lambda_function.step : k => v.arn },
    var.step_functions,
  )
}

data "aws_region" "this" {}
data "aws_caller_identity" "me" {}

# ---------- Lambda (stub-step) ----------
data "archive_file" "workflows" {
  type        = "zip"
  source_dir  = abspath("${path.root}/${var.lambda_dist}")
  output_path = "${path.root}/.build/workflows.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.n.prefix}-role-wf-lambda${var.n.suffix}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda" {
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = var.table_workflows.arn },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
    ]
  })
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = toset(["stub-step"])
  name              = "/aws/lambda/${var.n.prefix}-lambda-${each.key}${var.n.suffix}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

resource "aws_lambda_function" "fn" {
  for_each         = toset(["stub-step"])
  function_name    = "${var.n.prefix}-lambda-${each.key}${var.n.suffix}"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "${each.key}.handler"
  filename         = data.archive_file.workflows.output_path
  source_code_hash = data.archive_file.workflows.output_base64sha256
  timeout          = 30
  memory_size      = 256
  environment {
    variables = { TABLE_WORKFLOWS = var.table_workflows.name }
  }
  tracing_config { mode = "Active" }
  depends_on = [aws_cloudwatch_log_group.fn]
}

# ---------- yoyo0704 소유 단계 Lambda ----------
resource "aws_iam_role" "step" {
  name               = "${var.n.prefix}-role-wf-step${var.n.suffix}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "step_logs" {
  role       = aws_iam_role.step.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "step" {
  role = aws_iam_role.step.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = var.quarantine_bucket.arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectTagging", "s3:PutObject", "s3:DeleteObject"], Resource = "${var.quarantine_bucket.arn}/*" },
      { Effect = "Allow", Action = ["sagemaker:InvokeEndpointAsync"], Resource = "arn:aws:sagemaker:${data.aws_region.this.region}:${data.aws_caller_identity.me.account_id}:endpoint/${var.ocr_endpoint_name}" },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem"], Resource = var.table_documents.arn },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
    ]
  })
}

resource "aws_cloudwatch_log_group" "step" {
  for_each          = local.own_steps
  name              = "/aws/lambda/${var.n.prefix}-lambda-${replace(each.key, "_", "-")}${var.n.suffix}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

resource "aws_lambda_function" "step" {
  for_each         = local.own_steps
  function_name    = "${var.n.prefix}-lambda-${replace(each.key, "_", "-")}${var.n.suffix}"
  role             = aws_iam_role.step.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = each.value.handler
  filename         = data.archive_file.workflows.output_path
  source_code_hash = data.archive_file.workflows.output_base64sha256
  timeout          = each.value.timeout
  memory_size      = each.value.memory
  environment {
    variables = {
      TABLE_DOCUMENTS   = var.table_documents.name
      BUCKET_QUARANTINE = var.quarantine_bucket.name
      OCR_ENDPOINT_NAME = var.ocr_endpoint_name
    }
  }
  tracing_config { mode = "Active" }
  depends_on = [aws_cloudwatch_log_group.step]
}

# ---------- 업로드 트리거 큐 (모든 SQS 에 DLQ) ----------
resource "aws_sqs_queue" "q" {
  for_each                  = toset(["ingest-trigger-dlq"])
  name                      = "${var.n.prefix}-sqs-${each.key}${var.n.suffix}"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "trigger" {
  name                       = "${var.n.prefix}-sqs-ingest-trigger${var.n.suffix}"
  visibility_timeout_seconds = 300
  sqs_managed_sse_enabled    = true # EventBridge 는 AWS 관리형 KMS 키(alias/aws/sqs) 큐로 보낼 수 없음
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.q["ingest-trigger-dlq"].arn
    maxReceiveCount     = 3
  })
}

resource "aws_cloudwatch_event_rule" "upload" {
  name = "${var.n.prefix}-evr-upload${var.n.suffix}"
  event_pattern = jsonencode({
    source      = ["aws.s3"]
    detail-type = ["Object Created"]
    detail = {
      bucket = { name = [var.quarantine_bucket.name] }
      object = { key = [{ wildcard = "*/original.*" }] }
    }
  })
}

resource "aws_cloudwatch_event_target" "upload" {
  rule = aws_cloudwatch_event_rule.upload.name
  arn  = aws_sqs_queue.trigger.arn
}

resource "aws_sqs_queue_policy" "events" {
  for_each  = { trigger = aws_sqs_queue.trigger }
  queue_url = each.value.url
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = each.value.arn
      Condition = { ArnEquals = { "aws:SourceArn" = [aws_cloudwatch_event_rule.upload.arn] } }
    }]
  })
}

output "trigger_queue_url" { value = aws_sqs_queue.trigger.url }
output "trigger_queue_arn" { value = aws_sqs_queue.trigger.arn }
output "step_arns" { value = local.step_arns }
