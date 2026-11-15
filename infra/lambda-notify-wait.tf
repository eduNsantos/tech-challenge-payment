resource "aws_lambda_function" "notify_wait" {
  function_name    = "payment-notify-wait"
  role             = aws_iam_role.payment_lambda.arn
  runtime          = "nodejs24.x"
  handler          = local.newrelic_enabled ? local.newrelic_wrapper_handler : "notify-wait/index.handler"
  layers           = local.newrelic_layers
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = merge(
      {
        DYNAMODB_TABLE       = aws_dynamodb_table.payment_saga.name
        APP_NOTIFICATION_URL = var.app_notification_url
      },
      local.newrelic_env,
      local.newrelic_enabled ? { NEW_RELIC_LAMBDA_HANDLER = "notify-wait/index.handler" } : {},
    )
  }
}
