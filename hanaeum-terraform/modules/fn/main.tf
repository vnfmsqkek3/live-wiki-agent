# Lambda 1개 + 전용 Role(최소 권한) + 로그 그룹. 다른 Owner 코드(CodeBuild 빌드 zip, S3)를 공유 이름으로 배포할 때 쓴다.
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "name" { type = string }                                  # 함수 용도 (예: trust-gate)
variable "s3" { type = object({ bucket = string, key = string }) } # lambda_build 산출물
variable "handler" { type = string }
variable "env" {
  type    = map(string)
  default = {}
}
variable "statements" { type = any } # IAM statement 목록
variable "kms_key_arn" { type = string }
variable "memory" {
  type    = number
  default = 256
}
variable "timeout" {
  type    = number
  default = 30
}
variable "reserved_concurrency" {
  type    = number
  default = -1
}
variable "vpc" {
  type    = object({ subnet_ids = list(string), security_group_ids = list(string) })
  default = null # Neptune 처럼 VPC 안 자원을 부를 때
}
variable "model_caller" {
  type    = bool
  default = false # true 면 quarantine 원본 등급 키 읽기 거부 (s3 모듈)
}

locals { fn = "${var.n.prefix}-lambda-${var.name}${var.n.suffix}" }

resource "aws_iam_role" "fn" {
  name = "${var.n.prefix}-role-fn-${var.name}${var.n.suffix}"
  tags = var.model_caller ? { "hanaeum-model-caller" = "true" } : {}
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "vpc" {
  count      = var.vpc == null ? 0 : 1
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "fn" {
  role = aws_iam_role.fn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(var.statements, [
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
    ])
  })
}

resource "aws_cloudwatch_log_group" "fn" {
  name              = "/aws/lambda/${local.fn}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

resource "aws_lambda_function" "fn" {
  function_name                  = local.fn
  role                           = aws_iam_role.fn.arn
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  handler                        = var.handler
  s3_bucket                      = var.s3.bucket
  s3_key                         = var.s3.key
  memory_size                    = var.memory
  timeout                        = var.timeout
  reserved_concurrent_executions = var.reserved_concurrency
  environment { variables = var.env }
  dynamic "vpc_config" {
    for_each = var.vpc == null ? [] : [var.vpc]
    content {
      subnet_ids         = vpc_config.value.subnet_ids
      security_group_ids = vpc_config.value.security_group_ids
    }
  }
  tracing_config { mode = "Active" }
  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy.fn, aws_iam_role_policy_attachment.vpc]
}

output "arn" { value = aws_lambda_function.fn.arn }
output "name" { value = aws_lambda_function.fn.function_name }
output "role_arn" { value = aws_iam_role.fn.arn }
