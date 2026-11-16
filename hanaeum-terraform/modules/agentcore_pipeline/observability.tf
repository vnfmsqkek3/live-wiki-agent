# AgentCore Observability (dhxorb96 요청 11/16 20:50: 검증을 AgentCore Trace 로 한다)
#   Gateway·Runtime 의 APPLICATION_LOGS → CloudWatch Logs, TRACES → X-Ray
#   계정 단위: X-Ray 구간을 CloudWatch Logs(aws/spans)로 → CloudWatch Transaction Search / GenAI Observability

resource "aws_cloudwatch_log_group" "agentcore" {
  name              = "/aws/vendedlogs/bedrock-agentcore/${var.n.prefix}-pipeline${var.n.suffix}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

locals {
  obs_sources = merge(
    { gateway = aws_bedrockagentcore_gateway.pipeline.gateway_arn },
    var.runtime_image_tag == null ? {} : { runtime = aws_bedrockagentcore_agent_runtime.pipeline[0].agent_runtime_arn },
  )
}

resource "aws_cloudwatch_log_delivery_destination" "logs" {
  name = "${var.n.prefix}-ldd-agentcore-logs${var.n.suffix}"
  delivery_destination_configuration {
    destination_resource_arn = aws_cloudwatch_log_group.agentcore.arn
  }
}

resource "aws_cloudwatch_log_delivery_destination" "xray" {
  name                      = "${var.n.prefix}-ldd-agentcore-xray${var.n.suffix}"
  delivery_destination_type = "XRAY"
}

resource "aws_cloudwatch_log_delivery_source" "logs" {
  for_each     = local.obs_sources
  name         = "${var.n.prefix}-lds-${each.key}-logs${var.n.suffix}"
  log_type     = "APPLICATION_LOGS"
  resource_arn = each.value
}

resource "aws_cloudwatch_log_delivery_source" "traces" {
  for_each     = local.obs_sources
  name         = "${var.n.prefix}-lds-${each.key}-traces${var.n.suffix}"
  log_type     = "TRACES"
  resource_arn = each.value
}

resource "aws_cloudwatch_log_delivery" "logs" {
  for_each                 = local.obs_sources
  delivery_source_name     = aws_cloudwatch_log_delivery_source.logs[each.key].name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.logs.arn
}

resource "aws_cloudwatch_log_delivery" "traces" {
  for_each                 = local.obs_sources
  delivery_source_name     = aws_cloudwatch_log_delivery_source.traces[each.key].name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.xray.arn
}

# ---------- 계정 단위: Transaction Search ----------
resource "aws_cloudwatch_log_resource_policy" "xray_spans" {
  count       = var.enable_transaction_search ? 1 : 0
  policy_name = "hanaeum-mvp-xray-transaction-search"
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TransactionSearchXRayAccess"
      Effect    = "Allow"
      Principal = { Service = "xray.amazonaws.com" }
      Action    = "logs:PutLogEvents"
      Resource = [
        "arn:aws:logs:${local.region}:${local.acct}:log-group:aws/spans:*",
        "arn:aws:logs:${local.region}:${local.acct}:log-group:/aws/application-signals/data:*",
      ]
      Condition = {
        ArnLike      = { "aws:SourceArn" = "arn:aws:xray:${local.region}:${local.acct}:*" }
        StringEquals = { "aws:SourceAccount" = local.acct }
      }
    }]
  })
}

resource "aws_xray_trace_segment_destination" "cwl" {
  count       = var.enable_transaction_search ? 1 : 0
  destination = "CloudWatchLogs"
  depends_on  = [aws_cloudwatch_log_resource_policy.xray_spans]
}
