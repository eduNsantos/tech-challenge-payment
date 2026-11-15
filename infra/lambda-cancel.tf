resource "aws_lambda_function" "cancel" {
  function_name    = "payment-cancel"
  role             = data.aws_iam_role.lab_role.arn
  runtime          = "nodejs24.x"
  handler          = local.newrelic_enabled ? local.newrelic_wrapper_handler : "cancel/index.handler"
  layers           = local.newrelic_layers
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = merge(
      {
        DYNAMODB_TABLE            = aws_dynamodb_table.payment_saga.name
        MP_ACCESS_TOKEN_SECRET_ID = aws_secretsmanager_secret.mp_access_token.name
      },
      local.newrelic_env,
      local.newrelic_enabled ? { NEW_RELIC_LAMBDA_HANDLER = "cancel/index.handler" } : {},
    )
  }
}
