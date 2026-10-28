resource "aws_lambda_function" "generate_link" {
  function_name    = "payment-generate-link"
  role             = data.aws_iam_role.lab_role.arn
  runtime          = "nodejs24.x"
  handler          = "generate-link/index.handler"
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      MP_ACCESS_TOKEN_SECRET_ID = aws_secretsmanager_secret.mp_access_token.name
      WEBHOOK_URL               = "${aws_apigatewayv2_stage.default.invoke_url}webhook"
    }
  }
}
