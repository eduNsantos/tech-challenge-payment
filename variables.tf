variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "mp_access_token" {
  type        = string
  sensitive   = true
  description = "Access token de producao do Mercado Pago"
}

variable "mp_webhook_secret" {
  type        = string
  sensitive   = true
  description = "Secret HMAC-SHA256 para validar assinatura dos webhooks do Mercado Pago"
}

variable "app_notification_url" {
  type        = string
  description = "URL do servico de origem (App/EKS) para receber o link de pagamento gerado"
}
