resource "aws_lambda_function" "callback" {
  function_name    = "payment-callback"
  role             = aws_iam_role.payment_lambda.arn
  runtime          = "nodejs24.x"
  handler          = local.newrelic_enabled ? local.newrelic_wrapper_handler : "callback/index.handler"
  layers           = local.newrelic_layers
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = merge(
      {
        DYNAMODB_TABLE            = aws_dynamodb_table.payment_saga.name
        MP_WEBHOOK_SECRET_ID      = aws_secretsmanager_secret.mp_webhook_secret.name
        MP_ACCESS_TOKEN_SECRET_ID = aws_secretsmanager_secret.mp_access_token.name
      },
      local.newrelic_env,
      local.newrelic_enabled ? { NEW_RELIC_LAMBDA_HANDLER = "callback/index.handler" } : {},
    )
  }
}

resource "aws_lambda_permission" "apigateway_callback" {
  statement_id  = "AllowAPIGatewayInvokeCallback"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.callback.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.payment.execution_arn}/*/*"
}
