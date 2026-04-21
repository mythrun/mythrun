terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    bucket       = "mythrun-terraform-state"
    key          = "environments/shared/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "default"

  default_tags {
    tags = {
      Project     = "mythrun"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
