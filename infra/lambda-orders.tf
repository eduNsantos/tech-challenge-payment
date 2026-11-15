resource "aws_lambda_function" "orders" {
  function_name    = "payment-orders-api"
  role             = data.aws_iam_role.lab_role.arn
  runtime          = "nodejs24.x"
  handler          = local.newrelic_enabled ? local.newrelic_wrapper_handler : "orders/index.handler"
  layers           = local.newrelic_layers
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = merge(
      {
        SQS_QUEUE_URL = aws_sqs_queue.payment_orders.url
      },
      local.newrelic_env,
      local.newrelic_enabled ? { NEW_RELIC_LAMBDA_HANDLER = "orders/index.handler" } : {},
    )
  }
}

resource "aws_lambda_permission" "apigateway_orders" {
  statement_id  = "AllowAPIGatewayInvokeOrders"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.orders.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.payment.execution_arn}/*/*"
}
