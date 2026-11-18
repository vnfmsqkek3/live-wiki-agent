# PaddleOCR SageMaker Async 엔드포인트 (docs/04 2장, Owner yoyo0704).
# 이미지: services/ocr → CodeBuild(amd64) → ECR. 소스 해시가 바뀌면 다시 빌드하고 새 모델로 교체.
# 비용: min 0 / max 1. 요청 대기(HasBacklogWithoutCapacity)면 1대로, 대기열이 비면 0대로.
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "quarantine_bucket" { type = object({ name = string, arn = string }) }
# ml.g5.xlarge 는 us-east-1 InsufficientInstanceCapacity 로 실패 (트러블슈팅 11/16). T4 16GB 로 PP-OCRv5 mobile 충분
variable "instance_type" {
  type    = string
  default = "ml.g4dn.xlarge"
}
# 빌드할 커밋 (공개 저장소 services/ocr). 이미지 태그 = 커밋. 로컬 소스 업로드 없이 CodeBuild 가 clone (배포 원칙 11/16)
variable "source_ref" { type = string }
# 10쪽 청크 병렬 처리 (사용자 결정 11/17). 인스턴스당 동시 청크 = 모델 인스턴스 수 (실측 GPU 2.6GB/개, T4 16GB)
variable "concurrency" {
  type    = number
  default = 3
}
# 최소 인스턴스: 상시 1대 (사용자 결정 11/17 21시 "0대 말고 1로"). 0 이면 콜드 스타트 약 10분(실측: 경보 3.5분 + 기동·이미지 5.8분 + 모델 0.5분)
variable "min_instances" {
  type    = number
  default = 1
}
# 최대 인스턴스. 계정 한도 ml.g4dn.xlarge endpoint 2대(dev·prod 합) → 상향 신청 11/17 (6대 요청) 승인 뒤 prod 5
variable "max_instances" {
  type    = number
  default = 1
}
variable "repo_url" {
  type    = string
  default = "https://github.com/vnfmsqkek3/live-wiki-agent.git"
}


locals {
  name       = "${var.n.prefix}-sm-ocr${var.n.suffix}"
  async_root = "s3://${var.quarantine_bucket.name}/_ocr-async"
}

# ---------- 이미지 빌드 ----------
resource "aws_ecr_repository" "ocr" {
  name                 = "${var.n.prefix}-ecr-ocr${var.n.suffix}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.n.suffix != ""
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "ocr" {
  repository = aws_ecr_repository.ocr.name
  policy = jsonencode({ rules = [{
    rulePriority = 1, description = "keep last 5"
    selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
    action       = { type = "expire" }
  }] })
}

locals { tag = var.source_ref }

resource "aws_iam_role" "build" {
  name = "${var.n.prefix}-role-cb-ocr${var.n.suffix}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "codebuild.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "build" {
  role = aws_iam_role.build.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      # 베이스 이미지: AWS DLC (SageMaker GPU, 계정 763104351884)
      { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = "arn:aws:ecr:us-east-1:763104351884:repository/pytorch-inference" },
      {
        Effect = "Allow", Resource = aws_ecr_repository.ocr.arn
        Action = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages"]
      },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
    ]
  })
}

resource "aws_codebuild_project" "ocr" {
  name          = "${var.n.prefix}-cb-ocr${var.n.suffix}"
  service_role  = aws_iam_role.build.arn
  build_timeout = 90
  artifacts { type = "NO_ARTIFACTS" }
  environment {
    type            = "LINUX_CONTAINER"
    compute_type    = "BUILD_GENERAL1_LARGE"
    image           = "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    privileged_mode = true
    environment_variable {
      name  = "REPO"
      value = aws_ecr_repository.ocr.repository_url
    }
    environment_variable {
      name  = "TAG"
      value = local.tag
    }
    environment_variable {
      name  = "REPO_URL"
      value = var.repo_url
    }
  }
  source {
    type = "NO_SOURCE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        pre_build = { commands = [
          "aws ecr get-login-password | docker login --username AWS --password-stdin $${REPO%%/*}",
          "aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 763104351884.dkr.ecr.us-east-1.amazonaws.com",
        ] }
        build = { commands = [
          "if aws ecr describe-images --repository-name $${REPO#*/} --image-ids imageTag=$TAG >/dev/null 2>&1; then echo exists; exit 0; fi",
          "git clone --quiet $REPO_URL $CODEBUILD_SRC_DIR/src && cd $CODEBUILD_SRC_DIR/src && git checkout --quiet $TAG",
          "cd $CODEBUILD_SRC_DIR/src/services/ocr && docker build -t $REPO:$TAG .",
          "docker push $REPO:$TAG",
        ] }
      }
    })
  }
  logs_config {
    cloudwatch_logs { group_name = "/aws/codebuild/${var.n.prefix}-cb-ocr${var.n.suffix}" }
  }
}

resource "terraform_data" "build" {
  triggers_replace = [local.tag]
  provisioner "local-exec" {
    command = "${path.module}/../../scripts/codebuild-wait.sh ${aws_codebuild_project.ocr.name}"
  }
}

# ---------- SageMaker ----------
resource "aws_iam_role" "sm" {
  name = "${var.n.prefix}-role-sm-ocr${var.n.suffix}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "sagemaker.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "sm" {
  role = aws_iam_role.sm.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = aws_ecr_repository.ocr.arn },
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"], Resource = "*" },
      { Effect = "Allow", Action = ["cloudwatch:PutMetricData"], Resource = "*" },
      # SageMaker 가 엔드포인트 생성 시 async 출력 버킷에 ListBucket 권한을 검사한다
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = var.quarantine_bucket.arn },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = ["${var.quarantine_bucket.arn}/*/work/pages/*", "${var.quarantine_bucket.arn}/_ocr-async/in/*"] },
      { Effect = "Allow", Action = ["s3:PutObject", "s3:AbortMultipartUpload"], Resource = "${var.quarantine_bucket.arn}/_ocr-async/*" },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
    ]
  })
}

resource "aws_sagemaker_model" "ocr" {
  name               = "${local.name}-${local.tag}"
  execution_role_arn = aws_iam_role.sm.arn
  primary_container {
    image       = "${aws_ecr_repository.ocr.repository_url}:${local.tag}"
    environment = { OCR_WORKERS = tostring(var.concurrency) }
  }
  depends_on = [terraform_data.build, aws_iam_role_policy.sm]
}

resource "aws_sagemaker_endpoint_configuration" "ocr" {
  # 설정이 바뀔 때마다 새 이름 → 엔드포인트가 새 설정으로 갱신됨 (고정 이름이면 교체돼도 엔드포인트는 그대로)
  name_prefix = "${local.name}-"
  kms_key_arn = var.kms_key_arn
  production_variants {
    variant_name                                      = "AllTraffic"
    model_name                                        = aws_sagemaker_model.ocr.name
    instance_type                                     = var.instance_type
    initial_instance_count                            = 1
    container_startup_health_check_timeout_in_seconds = 1800 # 첫 기동 시 모델 다운로드
    # 기본 AMI 드라이버로는 paddle cu126 이 GPU 를 못 잡음 → 드라이버 550 / CUDA 12.4 AMI (트러블슈팅 11/16)
    inference_ami_version = "al2-ami-sagemaker-inference-gpu-3-1"
  }
  async_inference_config {
    client_config { max_concurrent_invocations_per_instance = var.concurrency }
    output_config {
      s3_output_path  = "${local.async_root}/out/"
      s3_failure_path = "${local.async_root}/fail/"
      kms_key_id      = var.kms_key_arn
    }
  }
  lifecycle { create_before_destroy = true }
}

resource "aws_sagemaker_endpoint" "ocr" {
  name                 = local.name
  endpoint_config_name = aws_sagemaker_endpoint_configuration.ocr.name
}

# ---------- 0 ↔ 1 오토스케일링 ----------
resource "aws_appautoscaling_target" "ocr" {
  service_namespace  = "sagemaker"
  resource_id        = "endpoint/${aws_sagemaker_endpoint.ocr.name}/variant/AllTraffic"
  scalable_dimension = "sagemaker:variant:DesiredInstanceCount"
  min_capacity       = var.min_instances
  max_capacity       = var.max_instances
}

# 업무·데모 시간 예열 (let522mj 11/17 실측: 0대에서 첫 요청까지 약 5분 → 업로드가 '문자 인식 중'에서 멈춘 것처럼 보임)
# 평일 08:30~19:00 KST 최소 1대, 그 밖에는 0대(요청이 오면 기존 wake 경보로 기동). ponytail: 시간 고정, 데모 일정이 바뀌면 cron 만 수정
# 상시 1대(min_instances=1)라 예열 예약은 끔. min_instances=0 으로 되돌릴 때만 true
variable "warm_hours" {
  type    = bool
  default = false
}
resource "aws_appautoscaling_scheduled_action" "warm" {
  count              = var.warm_hours ? 1 : 0
  name               = "${var.n.prefix}-ocr-warm${var.n.suffix}"
  service_namespace  = aws_appautoscaling_target.ocr.service_namespace
  resource_id        = aws_appautoscaling_target.ocr.resource_id
  scalable_dimension = aws_appautoscaling_target.ocr.scalable_dimension
  schedule           = "cron(30 8 ? * MON-FRI *)"
  timezone           = "Asia/Seoul"
  scalable_target_action {
    min_capacity = 1
    max_capacity = var.max_instances
  }
}
resource "aws_appautoscaling_scheduled_action" "cool" {
  count              = var.warm_hours ? 1 : 0
  name               = "${var.n.prefix}-ocr-cool${var.n.suffix}"
  service_namespace  = aws_appautoscaling_target.ocr.service_namespace
  resource_id        = aws_appautoscaling_target.ocr.resource_id
  scalable_dimension = aws_appautoscaling_target.ocr.scalable_dimension
  schedule           = "cron(0 19 ? * MON-FRI *)"
  timezone           = "Asia/Seoul"
  scalable_target_action {
    min_capacity = 0
    max_capacity = var.max_instances
  }
  depends_on = [aws_appautoscaling_scheduled_action.warm]
}

# 대기열이 0이면 축소 (target tracking, 기본 scale-in 쿨다운 후 0대)
resource "aws_appautoscaling_policy" "backlog" {
  name               = "${local.name}-backlog"
  service_namespace  = aws_appautoscaling_target.ocr.service_namespace
  resource_id        = aws_appautoscaling_target.ocr.resource_id
  scalable_dimension = aws_appautoscaling_target.ocr.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value       = var.concurrency # 인스턴스당 대기 청크가 동시 처리 수를 넘으면 증설 (max_instances 까지)
    scale_in_cooldown  = 600
    scale_out_cooldown = 60
    customized_metric_specification {
      metric_name = "ApproximateBacklogSizePerInstance"
      namespace   = "AWS/SageMaker"
      statistic   = "Average"
      dimensions {
        name  = "EndpointName"
        value = aws_sagemaker_endpoint.ocr.name
      }
    }
  }
}

# 0대일 때 요청이 오면 1대로 (target tracking 은 0에서 늘리지 못함)
resource "aws_appautoscaling_policy" "wake" {
  name               = "${local.name}-wake"
  service_namespace  = aws_appautoscaling_target.ocr.service_namespace
  resource_id        = aws_appautoscaling_target.ocr.resource_id
  scalable_dimension = aws_appautoscaling_target.ocr.scalable_dimension
  policy_type        = "StepScaling"
  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 300
    metric_aggregation_type = "Maximum"
    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "wake" {
  alarm_name          = "${local.name}-has-backlog-without-capacity"
  namespace           = "AWS/SageMaker"
  metric_name         = "HasBacklogWithoutCapacity"
  dimensions          = { EndpointName = aws_sagemaker_endpoint.ocr.name }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_appautoscaling_policy.wake.arn]
}

output "endpoint_name" { value = local.name } # 리소스가 아닌 이름: sfn 이 엔드포인트 생성에 묶이지 않게
output "async_root" { value = local.async_root }
