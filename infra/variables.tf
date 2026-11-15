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

# ── New Relic (opcional) ────────────────────────────────────────────────────
# Monitoramento só é ligado quando license key, account ID e layer ARN estão preenchidos.
# Com qualquer um vazio, as Lambdas sobem sem layer e com o handler original.

variable "newrelic_license_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "License key de ingestão do New Relic (tipo INGEST - LICENSE). Vazio = monitoramento desligado"
}

variable "newrelic_account_id" {
  type        = string
  default     = ""
  description = "Account ID do New Relic (necessário para distributed tracing)"
}

variable "newrelic_layer_arn" {
  type        = string
  default     = ""
  description = "ARN da layer New Relic para Node.js em us-east-1, ex.: arn:aws:lambda:us-east-1:451483290750:layer:NewRelicNodeJS24X:<versão>"

  validation {
    condition     = var.newrelic_layer_arn == "" || can(regex("^arn:aws:lambda:[a-z0-9-]+:451483290750:layer:NewRelicNodeJS[0-9]+X:[0-9]+$", var.newrelic_layer_arn))
    error_message = "newrelic_layer_arn deve ser uma layer NewRelicNodeJS<versão>X publicada pela conta 451483290750, com número de versão."
  }
}

variable "newrelic_app_name" {
  type        = string
  default     = "payment-service"
  description = "Nome da aplicação no New Relic (NEW_RELIC_APP_NAME)"
}
