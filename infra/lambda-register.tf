resource "aws_lambda_function" "register" {
  function_name    = "payment-register"
  role             = data.aws_iam_role.lab_role.arn
  runtime          = "nodejs24.x"
  handler          = "register/index.handler"
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      DYNAMODB_TABLE = aws_dynamodb_table.payment_saga.name
    }
  }
}
