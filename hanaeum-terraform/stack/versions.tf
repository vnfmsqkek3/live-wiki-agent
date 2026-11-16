terraform {
  required_version = ">= 1.14.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.73" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
    random  = { source = "hashicorp/random", version = "~> 3.7" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "hanaeum-mvp", Owner = var.owner, Env = var.env }
  }
}
