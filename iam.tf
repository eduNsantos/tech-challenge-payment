data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ── Step Functions role ────────────────────────────────────────────────────────

resource "aws_iam_role" "step_functions" {
  name = "payment-saga-step-functions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

data "aws_iam_policy_document" "step_functions" {
  statement {
    sid     = "InvokeLambdas"
    actions = ["lambda:InvokeFunction"]
    resources = [
      aws_lambda_function.register.arn,
      aws_lambda_function.generate_link.arn,
      aws_lambda_function.notify_wait.arn,
      aws_lambda_function.cancel.arn,
    ]
  }

  statement {
    sid       = "SendToDLQ"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }

  statement {
    sid       = "CloudWatchLogs"
    actions   = ["logs:CreateLogDelivery", "logs:PutLogEvents", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "step_functions" {
  name   = "payment-saga-step-functions"
  role   = aws_iam_role.step_functions.id
  policy = data.aws_iam_policy_document.step_functions.json
}
