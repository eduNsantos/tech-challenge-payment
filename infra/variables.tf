variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "mp_access_token" {
  type        = string
  sensitive   = true
  description = "Access token de producao do Mercado Pago"

  validation {
    condition     = length(trimspace(var.mp_access_token)) > 0
    error_message = "mp_access_token vazio — verifique o secret MP_ACCESS_TOKEN no GitHub ou o terraform.tfvars."
  }
}

variable "mp_webhook_secret" {
  type        = string
  sensitive   = true
  description = "Secret HMAC-SHA256 para validar assinatura dos webhooks do Mercado Pago"

  validation {
    condition     = length(trimspace(var.mp_webhook_secret)) > 0
    error_message = "mp_webhook_secret vazio — verifique o secret MP_WEBHOOK_SECRET no GitHub ou o terraform.tfvars."
  }
}

variable "app_notification_url" {
  type        = string
  default     = ""
  description = "Fallback opcional: URL para receber o link de pagamento quando a mensagem nao traz notification_url. O application envia notification_url em cada pedido, entao o deploy do payment-service nao depende da URL do app."
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
