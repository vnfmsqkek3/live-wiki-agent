# 단계 ConvertToPdf (사용자 결정 11/17 "모든 형식을 PDF 로 변환한 뒤 전부 OCR", Owner yoyo0704)
# LibreOffice 컨테이너 Lambda (services/convert-pdf). 이미지는 webapp CodeBuild(podman, arm64)가 lambda_refs.yoyo0704 커밋으로 빌드
locals {
  convert_ref = var.lambda_refs["yoyo0704"]
}

resource "aws_ecr_repository" "convert" {
  name                 = "${local.n.prefix}-ecr-convert${local.n.suffix}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !local.protect
  image_scanning_configuration { scan_on_push = true }
  # ponytail: 기본 AES256. KMS 로 바꾸면 Lambda 이미지 풀에 키 정책이 추가로 필요
}

resource "terraform_data" "convert_image" {
  input            = local.convert_ref
  triggers_replace = [local.convert_ref]
  provisioner "local-exec" {
    command = "${path.module}/../scripts/codebuild-wait.sh ${module.webapp[0].codebuild_project} APP=convert-pdf REF=${local.convert_ref} ECR_REPO=${aws_ecr_repository.convert.name} DOCKERFILE=services/convert-pdf/Dockerfile"
  }
}

resource "aws_iam_role" "convert" {
  name = "${local.n.prefix}-role-fn-convert-pdf${local.n.suffix}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "convert_logs" {
  role       = aws_iam_role.convert.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "convert" {
  role = aws_iam_role.convert.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(module.aurora.app_statements, [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = module.s3.buckets["quarantine"].arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectTagging"], Resource = "${module.s3.buckets["quarantine"].arn}/*/original.*" },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:PutObjectTagging"], Resource = "${module.s3.buckets["quarantine"].arn}/*/work/document.pdf" },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = module.kms.key_arn },
      { Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource = "*" },
    ])
  })
}

resource "aws_cloudwatch_log_group" "convert" {
  name              = "/aws/lambda/${local.n.prefix}-lambda-convert-pdf${local.n.suffix}"
  retention_in_days = 30
  kms_key_id        = module.kms.key_arn
}

resource "aws_lambda_function" "convert" {
  function_name = "${local.n.prefix}-lambda-convert-pdf${local.n.suffix}"
  role          = aws_iam_role.convert.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.convert.repository_url}:${terraform_data.convert_image.output}"
  architectures = ["arm64"]
  memory_size   = 3008
  timeout       = 600 # 사용자 결정: megazone-idp 와 같은 제한 600초
  ephemeral_storage { size = 4096 }
  environment {
    variables = merge(local.gov_env, { HOME = "/tmp" })
  }
  tracing_config { mode = "Active" }
  depends_on = [aws_cloudwatch_log_group.convert, aws_iam_role_policy.convert]
}
