resource "aws_secretsmanager_secret" "mp_access_token" {
  name                    = "payment/mp-access-token"
  description             = "Access token de producao do Mercado Pago"
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "mp_access_token" {
  secret_id = aws_secretsmanager_secret.mp_access_token.id
  secret_string = jsonencode({
    access_token = var.mp_access_token
  })
}

resource "aws_secretsmanager_secret" "mp_webhook_secret" {
  name                    = "payment/mp-webhook-secret"
  description             = "Secret HMAC-SHA256 para validar assinatura dos webhooks do Mercado Pago"
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "mp_webhook_secret" {
  secret_id = aws_secretsmanager_secret.mp_webhook_secret.id
  secret_string = jsonencode({
    webhook_secret = var.mp_webhook_secret
  })
}
