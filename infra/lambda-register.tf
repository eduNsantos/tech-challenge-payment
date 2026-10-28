resource "aws_iam_role" "register_lambda" {
  name               = "payment-register-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "register_vpc_access" {
  role       = aws_iam_role.register_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "register_lambda" {
  statement {
    sid       = "DynamoDBWrite"
    actions   = ["dynamodb:PutItem", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.payment_saga.arn]
  }
}

resource "aws_iam_role_policy" "register_lambda" {
  name   = "payment-register-lambda"
  role   = aws_iam_role.register_lambda.id
  policy = data.aws_iam_policy_document.register_lambda.json
}

resource "aws_lambda_function" "register" {
  function_name    = "payment-register"
  role             = aws_iam_role.register_lambda.arn
  runtime          = "nodejs24.x"
  handler          = "register/index.handler"
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 10
  memory_size      = 256

  vpc_config {
    subnet_ids         = [data.aws_subnet.sub_a.id, data.aws_subnet.sub_b.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      DYNAMODB_TABLE = aws_dynamodb_table.payment_saga.name
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.register_vpc_access,
    aws_iam_role_policy.register_lambda,
  ]
}
