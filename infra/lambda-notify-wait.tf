resource "aws_lambda_function" "notify_wait" {
  function_name    = "payment-notify-wait"
  role             = aws_iam_role.payment_lambda.arn
  runtime          = "nodejs24.x"
  handler          = "notify-wait/index.handler"
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      DYNAMODB_TABLE       = aws_dynamodb_table.payment_saga.name
      APP_NOTIFICATION_URL = var.app_notification_url
    }
  }
}
