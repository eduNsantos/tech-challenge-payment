resource "aws_iam_role" "generate_link_lambda" {
  name               = "payment-generate-link-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "generate_link_vpc_access" {
  role       = aws_iam_role.generate_link_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "generate_link_lambda" {
  statement {
    sid       = "SecretsManager"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.mp_access_token.arn]
  }
}

resource "aws_iam_role_policy" "generate_link_lambda" {
  name   = "payment-generate-link-lambda"
  role   = aws_iam_role.generate_link_lambda.id
  policy = data.aws_iam_policy_document.generate_link_lambda.json
}

resource "aws_lambda_function" "generate_link" {
  function_name    = "payment-generate-link"
  role             = aws_iam_role.generate_link_lambda.arn
  runtime          = "nodejs24.x"
  handler          = "generate-link/index.handler"
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
      MP_ACCESS_TOKEN_SECRET_ID = aws_secretsmanager_secret.mp_access_token.name
      WEBHOOK_URL               = "${aws_apigatewayv2_stage.default.invoke_url}webhook"
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.generate_link_vpc_access,
    aws_iam_role_policy.generate_link_lambda,
  ]
}
