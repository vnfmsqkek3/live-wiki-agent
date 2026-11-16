terraform {
  required_version = ">= 1.14.0"
  backend "s3" {
    bucket       = "hanaeum-mvp-s3-tfstate"
    key          = "dev/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

module "stack" {
  source      = "../../stack"
  env         = "dev"
  name_suffix = "-dev"
  owner       = "team"

  # dev: 각 Owner 의 개인 Lambda 연결 (요청기록 11/16 dhxorb96_to_yoyo0704 1809, let522mj_to_yoyo0704_lambda배포)
  step_functions = {
    file_structure_check = "hanaeum-mvp-lambda-file-structure-check-dhxorb96"
    pii_scan             = "hanaeum-mvp-lambda-pii-scan-dhxorb96"
    injection_scan       = "hanaeum-mvp-lambda-injection-scan-dhxorb96"
    classify             = "hanaeum-mvp-lambda-classify-dhxorb96"
    trust_gate           = "hanaeum-mvp-lambda-trust-gate-dhxorb96"
    wait_for_approval    = "hanaeum-mvp-lambda-wait-for-approval-dhxorb96"
    finalize             = "hanaeum-mvp-lambda-finalize-dhxorb96"
    text_layer_extract   = "hanaeum-mvp-lambda-text-layer-extract-let522mj"
    segment_build        = "hanaeum-mvp-lambda-segment-build-let522mj"
    promote              = "hanaeum-mvp-lambda-promote-let522mj"
    kb_ingest            = "hanaeum-mvp-lambda-kb-ingest-let522mj"
  }
  kb_chunker_lambda_arn = "hanaeum-mvp-lambda-kb-chunker-let522mj"
  kb_reader_role_arns   = ["hanaeum-mvp-role-mcp-let522mj"]
  # SQS 트리거는 공유 이름 type-detection (dhxorb96 개인 Role 에 SQS 권한 없음). zip: scripts/build-team-lambdas.sh
  team_lambdas = ["type-detection"]
}

output "ssm_prefix" { value = module.stack.ssm_prefix }
output "demo_users_secret" { value = module.stack.demo_users_secret }
