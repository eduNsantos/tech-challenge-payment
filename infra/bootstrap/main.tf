terraform {
  required_version = ">= 1.13.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
  # State local — propositalmente sem backend S3
  # Este módulo é rodado uma única vez para criar o bucket de state
}

provider "aws" {
  region = "us-east-1"
}

data "aws_caller_identity" "current" {}

locals {
  bucket_name = "techchallenge-tfstate-${data.aws_caller_identity.current.account_id}"
}

# Cria o bucket via AWS CLI para evitar chamadas bloqueadas pelo SCP do Academy
# (GetObjectLockConfiguration é negado pela SCP da organização Vocareum)
resource "null_resource" "tfstate_bucket" {
  triggers = {
    bucket_name = local.bucket_name
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      BUCKET="${local.bucket_name}"
      REGION="us-east-1"

      if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
        echo "Bucket $BUCKET ja existe."
      else
        echo "Criando bucket $BUCKET..."
        aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"

        aws s3api put-bucket-versioning \
          --bucket "$BUCKET" \
          --versioning-configuration Status=Enabled

        aws s3api put-bucket-encryption \
          --bucket "$BUCKET" \
          --server-side-encryption-configuration \
          '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

        aws s3api put-public-access-block \
          --bucket "$BUCKET" \
          --public-access-block-configuration \
          "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

        echo "Bucket $BUCKET criado com sucesso."
      fi
    EOT
    interpreter = ["bash", "-c"]
  }
}

# Gera infra/backend.hcl automaticamente com o nome do bucket
resource "local_file" "backend_hcl" {
  filename = "${path.module}/../backend.hcl"
  content  = "bucket = \"${local.bucket_name}\"\n"

  depends_on = [null_resource.tfstate_bucket]
}

output "bucket_name" {
  value       = local.bucket_name
  description = "Nome do bucket S3 criado para o Terraform state"
}

output "backend_hcl_path" {
  value       = abspath("${path.module}/../backend.hcl")
  description = "Caminho do backend.hcl gerado"
}
