# 문서 처리 워크플로 배선 (docs/04 1.1·1.2, Owner yoyo0704).
# S3(quarantine) ObjectCreated → EventBridge → SQS trigger(+DLQ) → [type-detection Lambda, dhxorb96] → Step Functions
# 실패 이중화: ASL Catch → HandleError_* (DynamoDB) + EventBridge SFN 상태 이벤트 → failure-catcher Lambda
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "table_workflows" { type = object({ name = string, arn = string }) }
variable "quarantine_bucket" { type = object({ name = string, arn = string }) }
variable "step_functions" { type = map(string) }
variable "lambda_dist" {
  type    = string
  default = "../../../workflows/dist" # npm run build -w workflows
}

locals {
  name = "${var.n.prefix}-sfn-ingest${var.n.suffix}"
  steps = [
    "malware_check", "file_structure_check", "text_layer_extract", "page_render", "ocr_if_needed",
    "segment_build", "pii_scan", "injection_scan", "classify", "trust_gate", "wait_for_approval",
    "promote", "kb_ingest", "graph_upsert", "finalize",
  ]
  # 비어 있는 단계는 stub(mock)
  step_arns = { for s in local.steps : s => lookup(var.step_functions, s, aws_lambda_function.fn["stub-step"].arn) }
}

data "aws_region" "this" {}
data "aws_caller_identity" "me" {}

# ---------- Lambda (failure-catcher, stub-step) ----------
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
  for_each          = toset(["failure-catcher", "stub-step"])
  name              = "/aws/lambda/${var.n.prefix}-lambda-${each.key}${var.n.suffix}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

resource "aws_lambda_function" "fn" {
  for_each         = toset(["failure-catcher", "stub-step"])
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

# ---------- Step Functions ----------
data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.me.account_id]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${var.n.prefix}-role-sfn-ingest${var.n.suffix}"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

resource "aws_iam_role_policy" "sfn" {
  role = aws_iam_role.sfn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = distinct(concat(values(local.step_arns), [for a in values(local.step_arns) : "${a}:*"])) },
      { Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = var.table_workflows.arn },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
      { Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], Resource = "*" },
      {
        Effect = "Allow"
        Action = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries",
        "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "sfn" {
  name              = "/aws/vendedlogs/states/${local.name}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

resource "aws_sfn_state_machine" "ingest" {
  name     = local.name
  role_arn = aws_iam_role.sfn.arn
  type     = "STANDARD"
  definition = templatefile("${path.module}/../../../workflows/asl/ingest.asl.json", merge(
    { for s, a in local.step_arns : "fn_${s}" => a },
    { table_workflows = var.table_workflows.name },
  ))
  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
    include_execution_data = false # 문서 내용·task token 이 로그에 남지 않게
    level                  = "ERROR"
  }
  tracing_configuration { enabled = true }
}

# ---------- 실패 이벤트 → failure-catcher ----------
resource "aws_cloudwatch_event_rule" "sfn_failed" {
  name = "${var.n.prefix}-evr-sfn-failed${var.n.suffix}"
  event_pattern = jsonencode({
    source      = ["aws.states"]
    detail-type = ["Step Functions Execution Status Change"]
    detail      = { status = ["FAILED", "TIMED_OUT", "ABORTED"], stateMachineArn = [aws_sfn_state_machine.ingest.arn] }
  })
}

resource "aws_cloudwatch_event_target" "sfn_failed" {
  rule = aws_cloudwatch_event_rule.sfn_failed.name
  arn  = aws_lambda_function.fn["failure-catcher"].arn
  retry_policy {
    maximum_retry_attempts       = 10
    maximum_event_age_in_seconds = 3600
  }
  dead_letter_config { arn = aws_sqs_queue.q["failure-dlq"].arn }
}

resource "aws_lambda_permission" "events" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["failure-catcher"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sfn_failed.arn
}

# ---------- 업로드 트리거 큐 (모든 SQS 에 DLQ) ----------
resource "aws_sqs_queue" "q" {
  for_each                  = toset(["ingest-trigger-dlq", "failure-dlq"])
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
  for_each  = { trigger = aws_sqs_queue.trigger, failure-dlq = aws_sqs_queue.q["failure-dlq"] }
  queue_url = each.value.url
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = each.value.arn
      Condition = { ArnEquals = { "aws:SourceArn" = [aws_cloudwatch_event_rule.upload.arn, aws_cloudwatch_event_rule.sfn_failed.arn] } }
    }]
  })
}

output "state_machine_arn" { value = aws_sfn_state_machine.ingest.arn }
output "trigger_queue_url" { value = aws_sqs_queue.trigger.url }
