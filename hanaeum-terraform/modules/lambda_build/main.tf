# Lambda 패키지 빌드 (배포 원칙 11/16: terraform apply 만으로 AWS 안에서 빌드, 로컬 빌드 산출물 업로드 금지)
#   구성 요소별 커밋(ref)을 공개 저장소에서 clone → CodeBuild(arm64)에서 각 Owner 빌드 명령 → s3://artifact/lambda/{구성요소}/{ref}/*.zip
#   yoyo0704: workflows.zip(단계 Lambda·stub·aoss-index), auth-triggers.zip
#   dhxorb96: dhxorb96-handlers.zip (apps/api build:lambda, handler handlers.<name>)
#   let522mj: {name}.zip (services/legal-etl/scripts/build-lambdas.ts, handler index.handler)
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "artifact_bucket" { type = object({ name = string, arn = string }) }
variable "refs" { type = map(string) } # { yoyo0704 = "<sha>", dhxorb96 = "<sha>", let522mj = "<sha>" }
variable "repo_url" {
  type    = string
  default = "https://github.com/vnfmsqkek3/live-wiki-agent.git"
}

locals { prefix = "lambda" }

resource "aws_iam_role" "build" {
  name = "${var.n.prefix}-role-cb-lambda${var.n.suffix}"
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
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${var.artifact_bucket.arn}/${local.prefix}/*" },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
    ]
  })
}

resource "aws_codebuild_project" "lambda" {
  name          = "${var.n.prefix}-cb-lambda${var.n.suffix}"
  service_role  = aws_iam_role.build.arn
  build_timeout = 30
  artifacts { type = "NO_ARTIFACTS" }
  environment {
    type         = "ARM_CONTAINER" # Lambda arm64 와 같은 아키텍처 (pdfjs canvas 네이티브 바이너리)
    compute_type = "BUILD_GENERAL1_LARGE"
    image        = "public.ecr.aws/docker/library/node:24-bookworm" # Node 24 (type stripping) + git. AL 이미지는 runtime-versions 없이 node 없음
    environment_variable {
      name  = "REPO_URL"
      value = var.repo_url
    }
    environment_variable {
      name  = "DEST"
      value = "s3://${var.artifact_bucket.name}/${local.prefix}"
    }
  }
  source {
    type = "NO_SOURCE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = { commands = ["node --version", "apt-get update -qq && apt-get install -y -qq zip awscli >/dev/null"] }
        pre_build = { commands = [
          "git clone --quiet $REPO_URL $CODEBUILD_SRC_DIR/src && cd $CODEBUILD_SRC_DIR/src && git checkout --quiet $REF",
          "cd $CODEBUILD_SRC_DIR/src && npm ci --no-audit --no-fund",
        ] }
        build = { commands = [
          "cd $CODEBUILD_SRC_DIR/src && mkdir -p out",
          <<-EOT
          cd $CODEBUILD_SRC_DIR/src && case "$COMPONENT" in
            yoyo0704)
              npm run package -w workflows --silent
              (cd workflows/.lambda && zip -qr ../../out/workflows.zip .)
              npm run build -w services/auth-triggers --silent
              (cd services/auth-triggers/dist && zip -qr ../../../out/auth-triggers.zip .) ;;
            dhxorb96)
              npm run build:lambda -w apps/api --silent
              zip -qj out/dhxorb96-handlers.zip apps/api/dist/handlers.mjs
              if [ -d mcp/gateway-interceptor ] && grep -q '"build"' mcp/gateway-interceptor/package.json; then
                OUT=$CODEBUILD_SRC_DIR/src/out
                npm run build -w @hanaeum/gateway-interceptor --silent && (cd mcp/gateway-interceptor/dist && zip -q "$OUT/interceptor.zip" index.mjs)
                npm run build -w @hanaeum/mcp-privacy-server --silent && (cd mcp/privacy-server/dist && zip -q "$OUT/mcp_privacy.zip" index.mjs)
                npm run build -w @hanaeum/mcp-approval-server --silent && (cd mcp/approval-server/dist && zip -q "$OUT/mcp_approval.zip" index.mjs)
              fi ;;
            let522mj)
              node services/legal-etl/scripts/build-lambdas.ts
              cp dist/lambda/*.zip out/ ;;
            *) echo "unknown COMPONENT $COMPONENT"; exit 1 ;;
          esac
          EOT
          ,
          "cd $CODEBUILD_SRC_DIR/src && ls -l out && aws s3 cp out $DEST/$COMPONENT/$REF/ --recursive --sse aws:kms --only-show-errors",
        ] }
      }
    })
  }
}

resource "terraform_data" "build" {
  for_each         = var.refs
  triggers_replace = [each.value]
  provisioner "local-exec" {
    command = "${path.module}/../../scripts/codebuild-wait.sh ${aws_codebuild_project.lambda.name} COMPONENT=${each.key} REF=${each.value}"
  }
  # 새 환경 첫 apply: Role 정책(로그 권한)이 붙기 전에 빌드가 시작되면 CLIENT_ERROR (prod 11/17 실측)
  depends_on = [aws_iam_role_policy.build]
}

# 구성 요소 → S3 키 접두사. 빌드가 끝난 뒤에만 쓰이도록 terraform_data 에 묶는다
output "prefix" {
  value      = { for k, v in var.refs : k => "${local.prefix}/${k}/${v}" }
  depends_on = [terraform_data.build]
}
output "bucket" { value = var.artifact_bucket.name }
