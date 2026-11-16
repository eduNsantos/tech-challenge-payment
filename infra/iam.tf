# Roles próprias do payment-ms.
# Mesmo padrão do tech-challenge-lambda-functions: role + policies com escopo mínimo.

# ─── Lambdas ─────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "payment_lambda" {
  name               = "payment-ms-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.payment_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "payment_lambda" {
  statement {
    sid = "DynamoDB"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = [
      aws_dynamodb_table.payment_saga.arn,
      "${aws_dynamodb_table.payment_saga.arn}/index/*",
    ]
  }

  statement {
    sid     = "SecretsManager"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.mp_access_token.arn,
      aws_secretsmanager_secret.mp_webhook_secret.arn,
    ]
  }

  # orders → SendMessage; trigger → consome via event source mapping
  statement {
    sid = "SQS"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.payment_orders.arn]
  }

  # trigger → StartExecution; callback/notify-wait → SendTaskSuccess/Failure
  statement {
    sid       = "StepFunctionsExecution"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.payment_saga.arn]
  }

  statement {
    sid = "StepFunctionsTaskToken"
    actions = [
      "states:SendTaskSuccess",
      "states:SendTaskFailure",
      "states:SendTaskHeartbeat",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "payment_lambda" {
  name   = "payment-ms-lambda-access"
  role   = aws_iam_role.payment_lambda.id
  policy = data.aws_iam_policy_document.payment_lambda.json
}

# ─── Step Functions ──────────────────────────────────────────────────────────

data "aws_iam_policy_document" "sfn_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "payment_sfn" {
  name               = "payment-ms-step-functions"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume_role.json
}

data "aws_iam_policy_document" "payment_sfn" {
  statement {
    sid     = "InvokeLambdas"
    actions = ["lambda:InvokeFunction"]
    resources = flatten([
      for fn in [
        aws_lambda_function.register,
        aws_lambda_function.generate_link,
        aws_lambda_function.notify_wait,
        aws_lambda_function.cancel,
      ] : [fn.arn, "${fn.arn}:*"]
    ])
  }

  statement {
    sid       = "SendToDLQ"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
}

resource "aws_iam_role_policy" "payment_sfn" {
  name   = "payment-ms-step-functions-access"
  role   = aws_iam_role.payment_sfn.id
  policy = data.aws_iam_policy_document.payment_sfn.json
}
