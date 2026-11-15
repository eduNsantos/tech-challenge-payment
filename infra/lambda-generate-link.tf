resource "aws_lambda_function" "generate_link" {
  function_name    = "payment-generate-link"
  role             = data.aws_iam_role.lab_role.arn
  runtime          = "nodejs24.x"
  handler          = local.newrelic_enabled ? local.newrelic_wrapper_handler : "generate-link/index.handler"
  layers           = local.newrelic_layers
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = merge(
      {
        MP_ACCESS_TOKEN_SECRET_ID = aws_secretsmanager_secret.mp_access_token.name
        WEBHOOK_URL               = "${aws_apigatewayv2_stage.default.invoke_url}webhook"
        BACK_URL_SUCCESS          = var.checkout_back_url_success
        BACK_URL_PENDING          = var.checkout_back_url_pending
        BACK_URL_FAILURE          = var.checkout_back_url_failure
      },
      local.newrelic_env,
      local.newrelic_enabled ? { NEW_RELIC_LAMBDA_HANDLER = "generate-link/index.handler" } : {},
    )
  }
}
