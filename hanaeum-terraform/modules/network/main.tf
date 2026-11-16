# VPC 3-tier (public / app / data), 2 AZ, NAT 1개, S3·DynamoDB Gateway Endpoint.
# ponytail: Interface Endpoint(bedrock-runtime 등)는 VPC 안 Lambda 가 생길 때(Neptune 단계) 추가.
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "cidr" {
  type    = string
  default = "10.40.0.0/16"
}

data "aws_availability_zones" "az" { state = "available" }
data "aws_region" "this" {}

locals {
  azs   = slice(data.aws_availability_zones.az.names, 0, 2)
  tiers = { public = 0, app = 1, data = 2 }
  # 10.40.{tier*16 + az}.0/24
  subnets = { for p in setproduct(keys(local.tiers), [0, 1]) : "${p[0]}-${p[1]}" => {
    tier = p[0], az = local.azs[p[1]], cidr = cidrsubnet(var.cidr, 8, local.tiers[p[0]] * 16 + p[1])
  } }
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "${var.n.prefix}-vpc-main${var.n.suffix}" }
}

resource "aws_default_security_group" "lockdown" { vpc_id = aws_vpc.this.id } # 기본 SG 규칙 제거

resource "aws_subnet" "s" {
  for_each          = local.subnets
  vpc_id            = aws_vpc.this.id
  cidr_block        = each.value.cidr
  availability_zone = each.value.az
  tags              = { Name = "${var.n.prefix}-subnet-${each.key}${var.n.suffix}", Tier = each.value.tier }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.n.prefix}-igw-main${var.n.suffix}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.n.prefix}-eip-nat${var.n.suffix}" }
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.s["public-0"].id
  tags          = { Name = "${var.n.prefix}-nat-main${var.n.suffix}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.n.prefix}-rt-public${var.n.suffix}" }
}

resource "aws_route_table" "app" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }
  tags = { Name = "${var.n.prefix}-rt-app${var.n.suffix}" }
}

# data 계층은 인터넷 경로 없음
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.n.prefix}-rt-data${var.n.suffix}" }
}

resource "aws_route_table_association" "a" {
  for_each       = local.subnets
  subnet_id      = aws_subnet.s[each.key].id
  route_table_id = { public = aws_route_table.public.id, app = aws_route_table.app.id, data = aws_route_table.data.id }[each.value.tier]
}

resource "aws_vpc_endpoint" "gw" {
  for_each          = toset(["s3", "dynamodb"])
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.this.region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.app.id, aws_route_table.data.id]
  tags              = { Name = "${var.n.prefix}-vpce-${each.key}${var.n.suffix}" }
}

output "vpc_id" { value = aws_vpc.this.id }
output "subnet_ids" {
  value = { for t in keys(local.tiers) : t => [for k, s in aws_subnet.s : s.id if local.subnets[k].tier == t] }
}
