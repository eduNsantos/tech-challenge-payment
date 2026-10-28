resource "aws_iam_role" "callback_lambda" {
  name               = "payment-callback-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "callback_vpc_access" {
  role       = aws_iam_role.callback_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "callback_lambda" {
  statement {
    sid       = "DynamoDB"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.payment_saga.arn]
  }

  statement {
    sid       = "StepFunctions"
    actions   = ["states:SendTaskSuccess", "states:SendTaskFailure"]
    resources = ["*"]
  }

  statement {
    sid       = "SecretsManager"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.mp_webhook_secret.arn]
  }
}

resource "aws_iam_role_policy" "callback_lambda" {
  name   = "payment-callback-lambda"
  role   = aws_iam_role.callback_lambda.id
  policy = data.aws_iam_policy_document.callback_lambda.json
}

resource "aws_lambda_function" "callback" {
  function_name    = "payment-callback"
  role             = aws_iam_role.callback_lambda.arn
  runtime          = "nodejs24.x"
  handler          = "callback/index.handler"
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
      DYNAMODB_TABLE              = aws_dynamodb_table.payment_saga.name
      MP_WEBHOOK_SECRET_ID        = aws_secretsmanager_secret.mp_webhook_secret.name
      MP_ACCESS_TOKEN_SECRET_ID   = aws_secretsmanager_secret.mp_access_token.name
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.callback_vpc_access,
    aws_iam_role_policy.callback_lambda,
  ]
}

resource "aws_lambda_permission" "apigateway_callback" {
  statement_id  = "AllowAPIGatewayInvokeCallback"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.callback.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.payment.execution_arn}/*/*"
}
