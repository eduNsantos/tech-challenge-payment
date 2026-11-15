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
