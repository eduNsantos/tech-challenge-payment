resource "aws_secretsmanager_secret" "mp_access_token" {
  name                    = "payment/mp-access-token"
  description             = "Access token de producao do Mercado Pago"
  recovery_window_in_days = 30
}

# O valor do access token NAO e variavel Terraform: o workflow de deploy grava o secret
# MP_ACCESS_TOKEN do GitHub direto no Secrets Manager apos o apply (fica fora do state).
# O Terraform so gerencia o secret em si.
# O `removed` tira a versao antiga do state sem apagar o valor ja gravado na AWS.
removed {
  from = aws_secretsmanager_secret_version.mp_access_token

  lifecycle {
    destroy = false
  }
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
