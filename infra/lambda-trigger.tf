resource "aws_lambda_function" "trigger" {
  function_name    = "payment-trigger"
  role             = data.aws_iam_role.lab_role.arn
  runtime          = "nodejs24.x"
  handler          = "trigger/index.handler"
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 60
  memory_size      = 256

  reserved_concurrent_executions = 5

  environment {
    variables = {
      STATE_MACHINE_ARN = aws_sfn_state_machine.payment_saga.arn
    }
  }
}

resource "aws_lambda_event_source_mapping" "sqs_trigger" {
  event_source_arn                   = aws_sqs_queue.payment_orders.arn
  function_name                      = aws_lambda_function.trigger.arn
  batch_size                         = 1
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_batching_window_in_seconds = 0
}
