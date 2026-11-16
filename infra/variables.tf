variable "aws_region" {
  type    = string
  default = "us-east-1"
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
  description = "Fallback: URL que recebe o link de pagamento quando a mensagem nao traz notification_url. Vazio = descobre pelo ELB do Service do app no EKS (app_k8s_service)."
}

variable "app_k8s_service" {
  type        = string
  default     = "postech/postech-app"
  description = "<namespace>/<service> do app no EKS; o ELB criado pelo Kubernetes tem a tag kubernetes.io/service-name com esse valor"
}

variable "app_port" {
  type        = number
  default     = 8080
  description = "Porta do Service LoadBalancer do app"
}

variable "link_retry_wait_seconds" {
  type        = number
  default     = 86400
  description = "Espera entre novas tentativas de gerar o link quando o Mercado Pago falha (padrão: 1 dia). Use valores baixos só para teste"

  validation {
    condition     = var.link_retry_wait_seconds >= 60
    error_message = "link_retry_wait_seconds deve ser >= 60."
  }
}

variable "link_retry_max_attempts" {
  type        = number
  default     = 3
  description = "Quantas novas tentativas (uma a cada link_retry_wait_seconds) antes de mandar o pedido para a DLQ"

  validation {
    condition     = var.link_retry_max_attempts >= 0 && var.link_retry_max_attempts <= 30
    error_message = "link_retry_max_attempts deve estar entre 0 e 30."
  }
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
# Monitoramento só é ligado quando license key e account ID estão preenchidos.
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

# Layer pública publicada pelo New Relic (conta AWS 451483290750) — versão fixada para deploy determinístico.
# Para atualizar: https://us-east-1.layers.newrelic-external.com/get-layers?CompatibleRuntime=nodejs24.x
variable "newrelic_layer_arn" {
  type        = string
  default     = "arn:aws:lambda:us-east-1:451483290750:layer:NewRelicNodeJS24X:65" # Extension v2.7.4 + Node agent v14.12.0
  description = "ARN da layer New Relic para Node.js 24 em us-east-1"

  validation {
    condition     = can(regex("^arn:aws:lambda:[a-z0-9-]+:451483290750:layer:NewRelicNodeJS[0-9]+X:[0-9]+$", var.newrelic_layer_arn))
    error_message = "newrelic_layer_arn deve ser uma layer NewRelicNodeJS<versão>X publicada pela conta 451483290750, com número de versão."
  }
}

variable "newrelic_app_name" {
  type        = string
  default     = "payment-service"
  description = "Nome da aplicação no New Relic (NEW_RELIC_APP_NAME)"
}
