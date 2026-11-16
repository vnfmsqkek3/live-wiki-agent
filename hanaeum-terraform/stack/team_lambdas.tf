# 다른 Owner 의 Lambda 를 공유 이름으로 배포 (요청기록 11/16 dhxorb96_to_yoyo0704, let522mj_to_yoyo0704_lambda배포).
# zip 은 lambda_build(CodeBuild)가 lambda_refs 커밋으로 빌드해 s3://artifact/lambda/{구성요소}/{ref}/ 에 둔다.
# 권한은 각 요청서의 "필요 권한" 그대로. graph 계열은 Neptune(11/20) 이후.
# 공유 이름으로 배포할 팀 Lambda 키 목록 (local.team 의 키 + "kb-chunker").
# dev: Owner 개인 Lambda 를 step_functions 로 연결하고 여기엔 type-detection 만 (SQS 권한). prod: 전부.
variable "team_lambdas" {
  type    = list(string)
  default = []
}

locals {
  # 구성 요소별 S3 접두사 (해당 ref 가 없으면 그 구성 요소 Lambda 는 team_lambdas 에 넣지 않는다)
  dz     = "${try(local.lb.prefix["dhxorb96"], "missing")}/dhxorb96-handlers.zip"
  lz     = try(local.lb.prefix["let522mj"], "missing")
  t      = module.ddb.tables
  b      = module.s3.buckets
  kb_arn = "arn:aws:bedrock:${var.region}:${data.aws_caller_identity.me.account_id}:knowledge-base/${module.kb.kb_id}"

  d_env = {
    TABLE_DOCUMENTS    = local.t["documents"].name
    TABLE_APPROVALS    = local.t["approvals"].name
    TABLE_AUDIT_EVENTS = local.t["audit_events"].name
    TABLE_FEEDBACK     = local.t["feedback"].name
    BUCKET_QUARANTINE  = local.b["quarantine"].name
    # Runtime 이 아직 없으면 빈 값 (type-detection 은 SFN 경로 유지)
    PIPELINE_RUNTIME_ARN = module.pipeline.runtime_arn != null ? module.pipeline.runtime_arn : ""
  }
  d_statements = [
    {
      Effect   = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
      Resource = [local.t["documents"].arn, local.t["approvals"].arn, "${local.t["approvals"].arn}/index/*", local.t["audit_events"].arn, local.t["feedback"].arn]
    },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = "${local.b["quarantine"].arn}/*" },
  ]
  q_rw = [
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = local.b["quarantine"].arn },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject"], Resource = "${local.b["quarantine"].arn}/*" },
  ]

  team = {
    # ---- dhxorb96 (apps/api handlers.mjs) ----
    type-detection = {
      zip = local.dz, handler = "handlers.typeDetection", env = local.d_env, memory = 256, timeout = 60, model_caller = false
      statements = concat(local.d_statements, [
        # AgentCore 오케스트레이터 시작 (Step Functions 폐기 11/16)
        { Effect = "Allow", Action = ["bedrock-agentcore:InvokeAgentRuntime"], Resource = [module.pipeline.runtime_arn_pattern, "${module.pipeline.runtime_arn_pattern}/*"] },
        { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = module.sfn.trigger_queue_arn },
      ])
    }
    file-structure-check = { zip = local.dz, handler = "handlers.fileStructureCheck", env = local.d_env, memory = 512, timeout = 60, model_caller = false, statements = local.d_statements }
    pii-scan = {
      zip = local.dz, handler = "handlers.piiScan", env = local.d_env, memory = 512, timeout = 120, model_caller = false
      statements = concat(local.d_statements, [
        { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${local.b["quarantine"].arn}/*/masked/*" },
        { Effect = "Allow", Action = ["s3:ListBucket"], Resource = local.b["quarantine"].arn },
      ])
    }
    injection-scan = {
      zip        = local.dz, handler = "handlers.injectionScan", env = local.d_env, memory = 256, timeout = 60, model_caller = false
      statements = concat(local.d_statements, [{ Effect = "Allow", Action = ["s3:ListBucket"], Resource = local.b["quarantine"].arn }])
    }
    # 모델 호출 Role (masked/ 만 읽음, 원본 등급 키는 버킷 정책이 거부)
    classify = {
      zip = local.dz, handler = "handlers.classify", memory = 512, timeout = 120, model_caller = true
      env = merge(local.d_env, { MODEL_HAIKU = var.models["MODEL_HAIKU"], MODEL_SONNET = var.models["MODEL_SONNET"] })
      statements = concat(local.d_statements, [
        { Effect = "Allow", Action = ["s3:ListBucket"], Resource = local.b["quarantine"].arn },
        { Effect = "Allow", Action = ["bedrock:InvokeModel", "bedrock:Converse"], Resource = ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:${var.region}:${local.acct}:inference-profile/*"] },
      ])
    }
    # 노하우 검증(Sonnet 판정) → 모델 호출 Role (dhxorb96 11/16). quarantine 은 masked/ 만 읽음 (원본 등급은 버킷 정책이 거부)
    trust-gate = {
      zip = local.dz, handler = "handlers.trustGate", memory = 512, timeout = 300, model_caller = true
      env = merge(local.d_env, {
        TABLE_REGULATIONS = local.t["regulations"].name, KB_ID = module.kb.kb_id, MODEL_RERANK = var.models["MODEL_RERANK"]
        MODEL_SONNET      = var.models["MODEL_SONNET"], MODEL_HAIKU = var.models["MODEL_HAIKU"]
      })
      statements = [
        { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:BatchGetItem"], Resource = local.t["documents"].arn },
        { Effect = "Allow", Action = ["dynamodb:Query"], Resource = local.t["regulations"].arn },
        { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${local.b["quarantine"].arn}/*/masked/*" },
        { Effect = "Allow", Action = ["s3:ListBucket"], Resource = local.b["quarantine"].arn },
        { Effect = "Allow", Action = ["bedrock:Retrieve"], Resource = local.kb_arn },
        { Effect = "Allow", Action = ["bedrock:Rerank"], Resource = "*" },
        { Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:${var.region}:${local.acct}:inference-profile/*"] },
      ]
    }
    wait-for-approval = { zip = local.dz, handler = "handlers.waitForApproval", env = local.d_env, memory = 256, timeout = 30, model_caller = false, statements = local.d_statements }
    finalize          = { zip = local.dz, handler = "handlers.finalize", env = local.d_env, memory = 256, timeout = 30, model_caller = false, statements = local.d_statements }

    # ---- let522mj (dist/lambda/{name}.zip, index.handler) ----
    text-layer-extract = { zip = "${local.lz}/text_layer_extract.zip", handler = "index.handler", env = {}, memory = 1024, timeout = 300, model_caller = false, statements = local.q_rw }
    segment-build      = { zip = "${local.lz}/segment_build.zip", handler = "index.handler", env = {}, memory = 1024, timeout = 300, model_caller = false, statements = local.q_rw }
    promote = {
      zip = "${local.lz}/promote.zip", handler = "index.handler", memory = 1024, timeout = 300, model_caller = false
      env = { BUCKET_PUBLISHED = local.b["published"].name, TABLE_DOCUMENTS = local.t["documents"].name, TABLE_APPROVALS = local.t["approvals"].name }
      statements = concat(local.q_rw, [
        { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${local.b["published"].arn}/*" },
        { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem"], Resource = local.t["documents"].arn },
        { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"], Resource = [local.t["approvals"].arn, "${local.t["approvals"].arn}/index/*"] },
      ])
    }
    kb-ingest = {
      zip = "${local.lz}/kb_ingest.zip", handler = "index.handler", memory = 256, timeout = 60, model_caller = false
      env = {
        KB_ID           = module.kb.kb_id, KB_DS_LEGAL_ID = module.kb.data_source_ids["legal"], KB_DS_KNOWLEDGE_ID = module.kb.data_source_ids["knowledge"]
        BUCKET_ARTIFACT = local.b["artifact"].name, TABLE_DOCUMENTS = local.t["documents"].name, TABLE_APPROVALS = local.t["approvals"].name
      }
      statements = [
        { Effect = "Allow", Action = ["bedrock:StartIngestionJob", "bedrock:GetIngestionJob", "bedrock:ListIngestionJobs"], Resource = local.kb_arn },
        { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${local.b["artifact"].arn}/kb-ingest/*" },
        { Effect = "Allow", Action = ["s3:ListBucket"], Resource = local.b["artifact"].arn },
        { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = [local.t["documents"].arn, local.t["approvals"].arn, "${local.t["approvals"].arn}/index/*"] },
      ]
    }
    mcp-regulation = {
      # fetch_official_law: AWS 관리형 Browser 로 law.go.kr 조회 (let522mj PR #6, 요청 2117). 실측 22초 → 90초
      zip = "${local.lz}/mcp_regulation.zip", handler = "index.handler", memory = 512, timeout = 90, model_caller = false
      env = { TABLE_REGULATIONS = local.t["regulations"].name }
      statements = [
        { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = local.t["regulations"].arn },
        {
          Effect   = "Allow"
          Action   = ["bedrock-agentcore:StartBrowserSession", "bedrock-agentcore:StopBrowserSession", "bedrock-agentcore:GetBrowserSession", "bedrock-agentcore:ConnectBrowserAutomationStream"]
          Resource = "arn:aws:bedrock-agentcore:${var.region}:aws:browser/aws.browser.v1"
        },
      ]
    }
    mcp-search = {
      zip = "${local.lz}/mcp_search.zip", handler = "index.handler", memory = 512, timeout = 30, model_caller = true
      env = { KB_ID = module.kb.kb_id, MODEL_RERANK = var.models["MODEL_RERANK"], TABLE_DOCUMENTS = local.t["documents"].name, TABLE_REGULATIONS = local.t["regulations"].name }
      statements = [
        { Effect = "Allow", Action = ["bedrock:Retrieve"], Resource = local.kb_arn },
        { Effect = "Allow", Action = ["bedrock:Rerank"], Resource = "*" },
        { Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = "arn:aws:bedrock:${var.region}::foundation-model/${var.models["MODEL_RERANK"]}" },
        { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem"], Resource = local.t["documents"].arn },
        { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = local.t["regulations"].arn },
      ]
    }
  }
}

data "aws_caller_identity" "me" {}

module "team" {
  source       = "../modules/fn"
  for_each     = { for k, v in local.team : k => v if contains(var.team_lambdas, k) }
  n            = local.n
  name         = each.key
  s3           = { bucket = local.lb.bucket, key = each.value.zip }
  handler      = each.value.handler
  env          = each.value.env
  statements   = each.value.statements
  memory       = each.value.memory
  timeout      = each.value.timeout
  model_caller = each.value.model_caller
  kms_key_arn  = module.kms.key_arn
}

# KB Custom Transformation (let522mj services/kb-chunker). KB 가 참조하므로 team 묶음과 분리 (순환 참조 방지)
module "kb_chunker" {
  source      = "../modules/fn"
  count       = contains(var.team_lambdas, "kb-chunker") ? 1 : 0
  n           = local.n
  name        = "kb-chunker"
  s3          = { bucket = local.lb.bucket, key = "${local.lz}/kb_chunker.zip" }
  handler     = "index.handler"
  memory      = 1024
  timeout     = 900
  kms_key_arn = module.kms.key_arn
  statements = [
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = module.s3.buckets["artifact"].arn },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${module.s3.buckets["artifact"].arn}/kb-intermediate/*" },
  ]
}

# 업로드 트리거 큐 → type-detection (batch 1)
resource "aws_lambda_event_source_mapping" "upload" {
  count            = contains(var.team_lambdas, "type-detection") ? 1 : 0
  event_source_arn = module.sfn.trigger_queue_arn
  function_name    = module.team["type-detection"].arn
  batch_size       = 1
}

locals {
  # Step Functions 단계 키(workflows/src/asl.ts) → 팀 Lambda 키. graph_upsert 는 Neptune 전까지 stub.
  step_fn = {
    file_structure_check = "file-structure-check", pii_scan = "pii-scan", injection_scan = "injection-scan", classify = "classify", trust_gate = "trust-gate", wait_for_approval = "wait-for-approval", finalize = "finalize"
    text_layer_extract   = "text-layer-extract", segment_build = "segment-build", promote = "promote", kb_ingest = "kb-ingest"
  }
  team_steps = { for step, fn in local.step_fn : step => module.team[fn].arn if contains(var.team_lambdas, fn) }

  # 변수에는 함수·Role 이름 또는 ARN 을 받는다 (public 저장소에 계정 ID 를 적지 않기 위해)
  acct            = data.aws_caller_identity.me.account_id
  lambda_arn      = { for k, v in var.step_functions : k => startswith(v, "arn:") ? v : "arn:aws:lambda:${var.region}:${local.acct}:function:${v}" }
  chunker_arn_var = var.kb_chunker_lambda_arn == null ? null : (startswith(var.kb_chunker_lambda_arn, "arn:") ? var.kb_chunker_lambda_arn : "arn:aws:lambda:${var.region}:${local.acct}:function:${var.kb_chunker_lambda_arn}")
  reader_roles    = [for r in var.kb_reader_role_arns : startswith(r, "arn:") ? r : "arn:aws:iam::${local.acct}:role/${r}"]
}

output "team_lambdas" { value = { for k, m in module.team : k => m.name } }
