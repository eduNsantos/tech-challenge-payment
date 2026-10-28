resource "aws_iam_role" "trigger_lambda" {
  name               = "payment-trigger-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "trigger_vpc_access" {
  role       = aws_iam_role.trigger_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "trigger_lambda" {
  statement {
    sid     = "ConsumeSQS"
    actions = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"]
    resources = [aws_sqs_queue.payment_orders.arn]
  }

  statement {
    sid       = "StartSAGA"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.payment_saga.arn]
  }
}

resource "aws_iam_role_policy" "trigger_lambda" {
  name   = "payment-trigger-lambda"
  role   = aws_iam_role.trigger_lambda.id
  policy = data.aws_iam_policy_document.trigger_lambda.json
}

resource "aws_lambda_function" "trigger" {
  function_name    = "payment-trigger"
  role             = aws_iam_role.trigger_lambda.arn
  runtime          = "nodejs24.x"
  handler          = "trigger/index.handler"
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 60
  memory_size      = 256

  reserved_concurrent_executions = 5

  vpc_config {
    subnet_ids         = [data.aws_subnet.sub_a.id, data.aws_subnet.sub_b.id]
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      STATE_MACHINE_ARN = aws_sfn_state_machine.payment_saga.arn
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.trigger_vpc_access,
    aws_iam_role_policy.trigger_lambda,
  ]
}

resource "aws_lambda_event_source_mapping" "sqs_trigger" {
  event_source_arn                   = aws_sqs_queue.payment_orders.arn
  function_name                      = aws_lambda_function.trigger.arn
  batch_size                         = 1
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_batching_window_in_seconds = 0
}
