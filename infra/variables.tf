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

variable "checkout_back_url_success" {
  type        = string
  default     = ""
  description = "back_urls.success do Checkout Pro (habilita auto_return=approved). Vazio = sem redirecionamento"
}

variable "checkout_back_url_pending" {
  type        = string
  default     = ""
  description = "back_urls.pending do Checkout Pro"
}

variable "checkout_back_url_failure" {
  type        = string
  default     = ""
  description = "back_urls.failure do Checkout Pro"
}
