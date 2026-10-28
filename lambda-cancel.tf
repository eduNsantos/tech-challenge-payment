resource "aws_iam_role" "cancel_lambda" {
  name               = "payment-cancel-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "cancel_vpc_access" {
  role       = aws_iam_role.cancel_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "cancel_lambda" {
  statement {
    sid       = "DynamoDB"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.payment_saga.arn]
  }

  statement {
    sid       = "SecretsManager"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.mp_access_token.arn]
  }
}

resource "aws_iam_role_policy" "cancel_lambda" {
  name   = "payment-cancel-lambda"
  role   = aws_iam_role.cancel_lambda.id
  policy = data.aws_iam_policy_document.cancel_lambda.json
}

resource "aws_lambda_function" "cancel" {
  function_name    = "payment-cancel"
  role             = aws_iam_role.cancel_lambda.arn
  runtime          = "nodejs24.x"
  handler          = "cancel/index.handler"
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 30
  memory_size      = 256

  vpc_config {
    subnet_ids         = [data.aws_subnet.sub_a.id, data.aws_subnet.sub_b.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      DYNAMODB_TABLE            = aws_dynamodb_table.payment_saga.name
      MP_ACCESS_TOKEN_SECRET_ID = aws_secretsmanager_secret.mp_access_token.name
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.cancel_vpc_access,
    aws_iam_role_policy.cancel_lambda,
  ]
}
