# 웹·API 배포 (dhxorb96 요청 11/16 웹API배포, 사용자 결정: 웹·API 모두 ECS Fargate)
#   CloudFront(+WAF) → ALB(public, CloudFront origin 대역만 허용) → /v1/*·/healthz: API(8080) / 나머지: 웹(3000)
#   이미지: public 저장소를 지정 커밋으로 clone → CodeBuild(arm64) → ECR. 코드 Owner dhxorb96 (apps/web, apps/api)
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "app_subnet_ids" { type = list(string) }
variable "repo_url" {
  type    = string
  default = "https://github.com/vnfmsqkek3/live-wiki-agent.git"
}
variable "source_ref" { type = string } # 빌드할 커밋 (짧은 SHA)
variable "cognito_user_pool_id" { type = string }
variable "cognito_client_id" { type = string }
variable "tables" { type = map(object({ name = string, arn = string })) }
variable "quarantine_bucket" { type = object({ name = string, arn = string }) }
variable "runtime_arn_patterns" { type = list(string) } # API 가 호출하는 AgentCore Runtime (파이프라인·가이드)
# 같은 CodeBuild 로 빌드하는 Agent 이미지의 ECR (파이프라인·가이드 Runtime)
variable "extra_ecr_arns" {
  type    = list(string)
  default = []
}
variable "api_env" {
  type    = map(string)
  default = {}
}

data "aws_region" "this" {}
data "aws_caller_identity" "me" {}
data "aws_ec2_managed_prefix_list" "cloudfront" { name = "com.amazonaws.global.cloudfront.origin-facing" }

locals {
  region = data.aws_region.this.region
  acct   = data.aws_caller_identity.me.account_id
  apps = {
    web = { port = 3000, health = "/", cpu = 256, memory = 512 }
    api = { port = 8080, health = "/healthz", cpu = 512, memory = 1024 }
  }
  tag = var.source_ref
}

# ---------- 이미지 ----------
resource "aws_ecr_repository" "app" {
  for_each             = local.apps
  name                 = "${var.n.prefix}-ecr-${each.key}${var.n.suffix}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.n.suffix != ""
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_iam_role" "build" {
  name = "${var.n.prefix}-role-cb-webapp${var.n.suffix}"
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
      {
        Effect = "Allow", Resource = concat([for r in aws_ecr_repository.app : r.arn], var.extra_ecr_arns)
        Action = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages"]
      },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
    ]
  })
}

resource "aws_codebuild_project" "app" {
  name          = "${var.n.prefix}-cb-webapp${var.n.suffix}"
  service_role  = aws_iam_role.build.arn
  build_timeout = 60
  artifacts { type = "NO_ARTIFACTS" }
  environment {
    type            = "ARM_CONTAINER" # Fargate ARM64
    compute_type    = "BUILD_GENERAL1_LARGE"
    image           = "public.ecr.aws/docker/library/fedora:42" # AL2023 저장소에 podman 없음 → Fedora(ECR Public 미러)
    privileged_mode = true
    environment_variable {
      name  = "REGISTRY"
      value = "${local.acct}.dkr.ecr.${local.region}.amazonaws.com"
    }
    environment_variable {
      name  = "REPO_URL"
      value = var.repo_url
    }
    environment_variable {
      name  = "COGNITO_CLIENT_ID"
      value = var.cognito_client_id
    }
    # 모든 podman 명령(login·build·push)이 같은 저장소 드라이버를 쓰게 (overlay/vfs DB 불일치 방지)
    environment_variable {
      name  = "STORAGE_DRIVER"
      value = "vfs"
    }
  }
  source {
    type = "NO_SOURCE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        # podman 사용 (사용자 지시 11/16: docker 라이선스 회피). CodeBuild 컨테이너 안이라 vfs 저장소·cgroupfs
        pre_build = { commands = [
          "dnf install -y -q podman git awscli2",
          # Docker Hub 비인증 pull 한도(toomanyrequests) 회피: docker.io 공식 이미지는 ECR Public 미러에서 먼저 받는다
          "printf '[[registry]]\\nprefix = \"docker.io\"\\nlocation = \"docker.io\"\\n[[registry.mirror]]\\nlocation = \"public.ecr.aws/docker\"\\n' > /etc/containers/registries.conf.d/99-ecr-public-mirror.conf",
          "aws ecr get-login-password | podman login --username AWS --password-stdin $REGISTRY",
          "git clone --quiet $REPO_URL $CODEBUILD_SRC_DIR/src && cd $CODEBUILD_SRC_DIR/src && git checkout --quiet $REF",
        ] }
        build = { commands = [
          "cd $CODEBUILD_SRC_DIR/src && podman --cgroup-manager=cgroupfs build --network=host --isolation=chroot --platform linux/arm64 -f $${DOCKERFILE:-apps/$APP/Dockerfile} --build-arg NEXT_PUBLIC_COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID -t $REGISTRY/$ECR_REPO:$REF .",
          "podman push $REGISTRY/$ECR_REPO:$REF",
        ] }
      }
    })
  }
}

resource "terraform_data" "build" {
  for_each         = local.apps
  triggers_replace = [local.tag, var.cognito_client_id]
  provisioner "local-exec" {
    command = "${path.module}/../../scripts/codebuild-wait.sh ${aws_codebuild_project.app.name} APP=${each.key} REF=${local.tag} ECR_REPO=${aws_ecr_repository.app[each.key].name}"
  }
}

# ---------- ECS ----------
resource "aws_ecs_cluster" "this" {
  name = "${var.n.prefix}-ecs-app${var.n.suffix}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = local.apps
  name              = "/ecs/${var.n.prefix}-${each.key}${var.n.suffix}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "exec" {
  name               = "${var.n.prefix}-role-ecs-exec${var.n.suffix}"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "exec_kms" {
  role   = aws_iam_role.exec.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn }] })
}

# 웹 Task Role: AWS 권한 없음
resource "aws_iam_role" "web" {
  name               = "${var.n.prefix}-role-ecs-web${var.n.suffix}"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# API Task Role (요청서 권한 목록). 원본 내용은 읽지 않음: HeadObject 가 s3:GetObject 권한을 요구해 original.* 에만 부여
resource "aws_iam_role" "api" {
  name               = "${var.n.prefix}-role-ecs-api${var.n.suffix}"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "api" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem"]
        Resource = flatten([for k in ["documents", "approvals", "feedback", "audit_events", "workflows"] : [var.tables[k].arn, "${var.tables[k].arn}/index/*"]])
      },
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${var.quarantine_bucket.arn}/*/original.*" },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${var.quarantine_bucket.arn}/*/original.*" },
      # 문서보관함 상세: 페이지별 마스킹본 표시 (dhxorb96 요청 2220). 원본·work/ 는 열지 않는다
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${var.quarantine_bucket.arn}/*/masked/segments/*" },
      {
        Effect    = "Allow", Action = ["s3:ListBucket"], Resource = var.quarantine_bucket.arn
        Condition = { StringLike = { "s3:prefix" = ["*/masked/segments/*"] } }
      },
      # 근거 조문 밑줄(buildMarks)
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = var.tables["regulations"].arn },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
      { Effect = "Allow", Action = ["bedrock-agentcore:InvokeAgentRuntime"], Resource = flatten([for p in var.runtime_arn_patterns : [p, "${p}/*"]]) },
      { Effect = "Allow", Action = ["bedrock:ApplyGuardrail"], Resource = "arn:aws:bedrock:${local.region}:${local.acct}:guardrail/*" },
    ]
  })
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = local.apps
  family                   = "${var.n.prefix}-${each.key}${var.n.suffix}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = each.key == "api" ? aws_iam_role.api.arn : aws_iam_role.web.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = each.key
    image        = "${aws_ecr_repository.app[each.key].repository_url}:${local.tag}"
    essential    = true
    portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]
    environment = [for k, v in(each.key == "api" ? merge(var.api_env, {
      AWS_REGION           = local.region
      COGNITO_USER_POOL_ID = var.cognito_user_pool_id
      COGNITO_CLIENT_ID    = var.cognito_client_id
      TABLE_DOCUMENTS      = var.tables["documents"].name
      TABLE_APPROVALS      = var.tables["approvals"].name
      TABLE_FEEDBACK       = var.tables["feedback"].name
      TABLE_AUDIT_EVENTS   = var.tables["audit_events"].name
      TABLE_WORKFLOWS      = var.tables["workflows"].name
      TABLE_REGULATIONS    = var.tables["regulations"].name
      BUCKET_QUARANTINE    = var.quarantine_bucket.name
      WEB_ORIGINS          = "https://${aws_cloudfront_distribution.this.domain_name}"
    }) : { PORT = "3000" }) : { name = k, value = v }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.app[each.key].name, "awslogs-region" = local.region, "awslogs-stream-prefix" = each.key }
    }
  }])
  depends_on = [terraform_data.build]
}

# ---------- 네트워크 ----------
resource "aws_security_group" "alb" {
  name        = "${var.n.prefix}-sg-alb${var.n.suffix}"
  description = "ALB: CloudFront origin-facing only"
  vpc_id      = var.vpc_id
  ingress {
    description     = "HTTP from CloudFront"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }
  egress {
    description = "to tasks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "task" {
  name        = "${var.n.prefix}-sg-ecs-app${var.n.suffix}"
  description = "ECS tasks: from ALB only"
  vpc_id      = var.vpc_id
  ingress {
    description     = "from ALB"
    from_port       = 3000
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    description = "AWS APIs via NAT/endpoints"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "this" {
  name                       = "${var.n.prefix}-alb-app${var.n.suffix}"
  load_balancer_type         = "application"
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  idle_timeout               = 300 # 스트리밍 응답 (기본 60초)
}

resource "aws_lb_target_group" "app" {
  for_each    = local.apps
  name        = "${var.n.prefix}-tg-${each.key}${var.n.suffix}"
  port        = each.value.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = each.value.health
    matcher = "200"
  }
  deregistration_delay = 10
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app["web"].arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app["api"].arn
  }
  condition {
    path_pattern { values = ["/v1/*", "/healthz"] }
  }
}

resource "aws_ecs_service" "app" {
  for_each        = local.apps
  name            = "${var.n.prefix}-svc-${each.key}${var.n.suffix}"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.app[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.app_subnet_ids
    security_groups = [aws_security_group.task.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app[each.key].arn
    container_name   = each.key
    container_port   = each.value.port
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener_rule.api]
}

# ---------- CloudFront + WAF ----------
resource "aws_wafv2_web_acl" "this" {
  name  = "${var.n.prefix}-waf-web${var.n.suffix}"
  scope = "CLOUDFRONT"
  default_action {
    allow {}
  }
  rule {
    name     = "aws-common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
        # 업로드 본문은 S3 presigned 로 직접 가지만, API JSON 본문이 8KB 를 넘을 수 있어 본문 크기 규칙은 COUNT
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-common"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "aws-bad-inputs"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-bad-inputs"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "rate-limit-ip"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-ip"
      sampled_requests_enabled   = true
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.n.prefix}-waf-web${var.n.suffix}"
    sampled_requests_enabled   = true
  }
}

data "aws_cloudfront_cache_policy" "disabled" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_cache_policy" "optimized" { name = "Managed-CachingOptimized" }
data "aws_cloudfront_origin_request_policy" "all_viewer" { name = "Managed-AllViewerExceptHostHeader" }

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  comment         = "${var.n.prefix} web+api${var.n.suffix}"
  web_acl_id      = aws_wafv2_web_acl.this.arn
  price_class     = "PriceClass_200"
  is_ipv6_enabled = true
  origin {
    origin_id   = "alb"
    domain_name = aws_lb.this.dns_name
    custom_origin_config {
      http_port  = 80
      https_port = 443
      # 스트리밍(SSE·chunked) 응답: 바이트 사이 공백을 60초까지 허용 (기본 30초면 Agent 추론 중 끊김)
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
      origin_protocol_policy   = "http-only" # ponytail: ALB 는 CloudFront 대역만 허용. 커스텀 도메인·ACM 생기면 https-only
      origin_ssl_protocols     = ["TLSv1.2"]
    }
  }
  # API: 캐시 끔 + Authorization 등 viewer 헤더 전달
  ordered_cache_behavior {
    path_pattern             = "/v1/*"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    compress                 = false # SSE(text/event-stream) 를 압축·버퍼링하지 않게 (13항 11)
  }
  ordered_cache_behavior {
    path_pattern             = "/healthz"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }
  # 웹 정적 파일만 캐시
  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true
  }
  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    compress                 = true
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
}

output "url" { value = "https://${aws_cloudfront_distribution.this.domain_name}" }
output "api_task_role_arn" { value = aws_iam_role.api.arn }
output "codebuild_project" { value = aws_codebuild_project.app.name }
