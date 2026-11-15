# New Relic — Lambda Extension + agente Node.js via layer.
# Não cria IAM role (bloqueado pelo SCP do AWS Academy): a extensão envia a telemetria
# direto para o New Relic usando a license key, lida do Secrets Manager com a LabRole.

locals {
  newrelic_enabled = (
    trimspace(var.newrelic_license_key) != "" &&
    trimspace(var.newrelic_account_id) != ""
  )

  newrelic_layers = local.newrelic_enabled ? [var.newrelic_layer_arn] : []

  # Handler do wrapper da layer; o handler original vai em NEW_RELIC_LAMBDA_HANDLER
  newrelic_wrapper_handler = "newrelic-lambda-wrapper.handler"

  newrelic_env = local.newrelic_enabled ? {
    NEW_RELIC_ACCOUNT_ID                   = var.newrelic_account_id
    NEW_RELIC_TRUSTED_ACCOUNT_KEY          = var.newrelic_account_id
    NEW_RELIC_APP_NAME                     = var.newrelic_app_name
    NEW_RELIC_LICENSE_KEY_SECRET           = aws_secretsmanager_secret.newrelic_license_key[0].name
    NEW_RELIC_EXTENSION_SEND_FUNCTION_LOGS = "true"
    NEW_RELIC_EXTENSION_LOG_LEVEL          = "INFO"
    NEW_RELIC_DISTRIBUTED_TRACING_ENABLED  = "true"
    NEW_RELIC_NO_CONFIG_FILE               = "true"
  } : {}
}

resource "aws_secretsmanager_secret" "newrelic_license_key" {
  count                   = local.newrelic_enabled ? 1 : 0
  name                    = "payment/newrelic-license-key"
  description             = "License key de ingestao do New Relic (lida pela New Relic Lambda Extension)"
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "newrelic_license_key" {
  count     = local.newrelic_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.newrelic_license_key[0].id
  # Formato esperado pela extensão: {"LicenseKey": "..."}
  secret_string = jsonencode({
    LicenseKey = var.newrelic_license_key
  })
}
