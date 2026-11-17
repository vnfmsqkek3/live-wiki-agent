# 거버넌스 저장소 Aurora PostgreSQL Serverless v2 (사용자 결정 11/17: 문서 메타데이터·검수·승인·피드백·감사 → PostgreSQL)
# 접근은 RDS Data API(HTTPS + IAM + Secrets Manager)만: Lambda·ECS 를 VPC 에 넣지 않아도 되고 연결 풀 관리가 필요 없다.
# DB 사용자 2개: master(관리형 비밀번호, 마이그레이션 전용) / app(애플리케이션, audit_events 는 INSERT·SELECT 만)
# 스키마: hanaeum-terraform/db/migrations/*.sql 을 scripts/db-migrate.sh 가 순서대로 1회씩 적용 (schema_migrations 기록)
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "vpc_id" { type = string }
variable "data_subnet_ids" { type = list(string) }
variable "engine_version" {
  type    = string
  default = "17.9" # aurora-postgresql 기본 버전 (11/17 describe-db-engine-versions --default-only)
}
# dev 는 0 ACU 자동 일시정지(첫 요청 재개 ~15초), prod 는 상시 0.5 ACU
variable "min_acu" { type = number }
variable "max_acu" {
  type    = number
  default = 4
}
variable "deletion_protection" { type = bool }

locals {
  name    = "${var.n.prefix}-aurora${var.n.suffix}"
  db_name = "hanaeum"
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.n.prefix}-dbsubnet${var.n.suffix}"
  subnet_ids = var.data_subnet_ids
}

# Data API 만 쓰므로 인바운드 규칙 없음 (VPC 안 직접 연결 차단)
resource "aws_security_group" "db" {
  name        = "${var.n.prefix}-sg-aurora${var.n.suffix}"
  description = "Aurora PostgreSQL (Data API only, no inbound)"
  vpc_id      = var.vpc_id
}

resource "aws_rds_cluster" "this" {
  cluster_identifier                  = local.name
  engine                              = "aurora-postgresql"
  engine_mode                         = "provisioned"
  engine_version                      = var.engine_version
  database_name                       = local.db_name
  master_username                     = "hanaeum_admin"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = var.kms_key_arn
  enable_http_endpoint                = true # RDS Data API
  storage_encrypted                   = true
  kms_key_id                          = var.kms_key_arn
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  backup_retention_period             = 7
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = !var.deletion_protection
  final_snapshot_identifier           = var.deletion_protection ? "${local.name}-final" : null
  iam_database_authentication_enabled = false
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  serverlessv2_scaling_configuration {
    min_capacity             = var.min_acu
    max_capacity             = var.max_acu
    seconds_until_auto_pause = var.min_acu == 0 ? 1800 : null
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier           = "${local.name}-1"
  cluster_identifier   = aws_rds_cluster.this.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.this.engine
  engine_version       = aws_rds_cluster.this.engine_version
  db_subnet_group_name = aws_db_subnet_group.this.name
}

# 애플리케이션 사용자 비밀번호. 사용자 생성·비밀번호 설정은 마이그레이션(000_app_role) 이 Data API 로 수행
resource "random_password" "app" {
  length           = 32
  override_special = "_-"
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.n.prefix}/aurora-app${var.n.suffix}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.deletion_protection ? 7 : 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({ username = "hanaeum_app", password = random_password.app.result, engine = "postgres", dbname = local.db_name })
}

output "cluster_arn" { value = aws_rds_cluster.this.arn }
output "db_name" { value = local.db_name }
output "app_secret_arn" { value = aws_secretsmanager_secret.app.arn }
output "master_secret_arn" { value = aws_rds_cluster.this.master_user_secret[0].secret_arn }
# 애플리케이션 Role 에 붙일 권한 (Data API + app secret 만. master secret 은 마이그레이션 전용)
output "app_statements" {
  value = [
    { Effect = "Allow", Action = ["rds-data:ExecuteStatement", "rds-data:BatchExecuteStatement", "rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction"], Resource = aws_rds_cluster.this.arn },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.app.arn },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn },
  ]
}
output "writer_ready" { value = aws_rds_cluster_instance.writer.id }
