resource "aws_lambda_function" "trigger" {
  function_name    = "payment-trigger"
  role             = aws_iam_role.payment_lambda.arn
  runtime          = "nodejs24.x"
  handler          = "trigger/index.handler"
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 60
  memory_size      = 256

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

  # Limita a 5 execuções concorrentes via SQS. Não usa reserved_concurrent_executions
  # porque a conta tem limite total de 10 e a AWS exige 10 não reservadas.
  scaling_config {
    maximum_concurrency = 5
  }
}
