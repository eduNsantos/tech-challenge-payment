resource "aws_iam_role" "notify_wait_lambda" {
  name               = "payment-notify-wait-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "notify_wait_vpc_access" {
  role       = aws_iam_role.notify_wait_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "notify_wait_lambda" {
  statement {
    sid       = "DynamoDBUpdate"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.payment_saga.arn]
  }
}

resource "aws_iam_role_policy" "notify_wait_lambda" {
  name   = "payment-notify-wait-lambda"
  role   = aws_iam_role.notify_wait_lambda.id
  policy = data.aws_iam_policy_document.notify_wait_lambda.json
}

resource "aws_lambda_function" "notify_wait" {
  function_name    = "payment-notify-wait"
  role             = aws_iam_role.notify_wait_lambda.arn
  runtime          = "nodejs24.x"
  handler          = "notify-wait/index.handler"
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 15
  memory_size      = 256

  vpc_config {
    subnet_ids         = [data.aws_subnet.sub_a.id, data.aws_subnet.sub_b.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      DYNAMODB_TABLE       = aws_dynamodb_table.payment_saga.name
      APP_NOTIFICATION_URL = var.app_notification_url
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.notify_wait_vpc_access,
    aws_iam_role_policy.notify_wait_lambda,
  ]
}
