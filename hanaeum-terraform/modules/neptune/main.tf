variable "protect" {
  type    = bool
  default = false # true: 삭제 보호·저장소 강제 삭제 금지 (stack local.protect)
}
# Neptune Serverless (조문·노하우 관계 그래프, Change Impact). docs/04 5장, IAM 인증, data 서브넷.
# 11/20 일정이었으나 사용자 지시(기능 축소 금지·오늘 안에)로 앞당김. 쓰기는 graph-upsert(reserved concurrency 1)만.
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "vpc_id" { type = string }
variable "data_subnet_ids" { type = list(string) }
variable "engine_version" {
  type    = string
  default = "1.5.0.0"
}

resource "aws_neptune_subnet_group" "this" {
  name       = "${var.n.prefix}-neptune-subnets${var.n.suffix}"
  subnet_ids = var.data_subnet_ids
}

# 그래프 Lambda 가 붙는 SG. Neptune 은 이 SG 에서 오는 8182 만 허용
resource "aws_security_group" "client" {
  name        = "${var.n.prefix}-sg-neptune-client${var.n.suffix}"
  description = "Lambdas that query Neptune"
  vpc_id      = var.vpc_id
  egress {
    description = "Neptune and AWS APIs"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "neptune" {
  name        = "${var.n.prefix}-sg-neptune${var.n.suffix}"
  description = "Neptune: graph Lambdas only"
  vpc_id      = var.vpc_id
  ingress {
    description     = "openCypher HTTPS from graph Lambdas"
    from_port       = 8182
    to_port         = 8182
    protocol        = "tcp"
    security_groups = [aws_security_group.client.id]
  }
}

resource "aws_neptune_cluster" "this" {
  cluster_identifier                  = "${var.n.prefix}-neptune${var.n.suffix}"
  engine                              = "neptune"
  engine_version                      = var.engine_version
  iam_database_authentication_enabled = true
  storage_encrypted                   = true
  kms_key_arn                         = var.kms_key_arn
  neptune_subnet_group_name           = aws_neptune_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.neptune.id]
  backup_retention_period             = var.n.suffix == "" ? 7 : 1
  skip_final_snapshot                 = !var.protect
  deletion_protection                 = var.protect
  apply_immediately                   = true
  serverless_v2_scaling_configuration {
    min_capacity = 1 # ponytail: 최소 1 NCU 상시 과금. 데모 후 사용 없으면 0.0(자동 일시정지 지원 버전)으로 검토
    max_capacity = 8
  }
}

resource "aws_neptune_cluster_instance" "this" {
  identifier         = "${var.n.prefix}-neptune-1${var.n.suffix}"
  cluster_identifier = aws_neptune_cluster.this.id
  engine             = "neptune"
  instance_class     = "db.serverless"
  apply_immediately  = true
}

output "endpoint" { value = "${aws_neptune_cluster.this.endpoint}:${aws_neptune_cluster.this.port}" }
output "client_sg_id" { value = aws_security_group.client.id }
# IAM 인증 리소스 (neptune-db:*)
output "db_resource_arn" {
  value = "arn:aws:neptune-db:${split(":", aws_neptune_cluster.this.arn)[3]}:${split(":", aws_neptune_cluster.this.arn)[4]}:${aws_neptune_cluster.this.cluster_resource_id}/*"
}
