resource "aws_sfn_state_machine" "payment_saga" {
  name     = "payment-saga"
  role_arn = aws_iam_role.payment_sfn.arn
  type     = "STANDARD"

  # A definição (ASL) fica em state-machine/payment-saga.asl.json para ser a mesma
  # que os testes BDD (src/features) executam. jsonencode(jsondecode()) mantém a string
  # idêntica à versão anterior em HCL — sem diff no plan.
  definition = jsonencode(jsondecode(templatefile("${path.module}/state-machine/payment-saga.asl.json", {
    register_function_arn      = aws_lambda_function.register.arn
    generate_link_function_arn = aws_lambda_function.generate_link.arn
    notify_wait_function_arn   = aws_lambda_function.notify_wait.arn
    cancel_function_arn        = aws_lambda_function.cancel.arn
    dlq_url                    = aws_sqs_queue.dlq.url
    link_retry_max_attempts    = var.link_retry_max_attempts
    link_retry_wait_seconds    = var.link_retry_wait_seconds
  })))

  tags = {
    Name = "payment-saga"
  }
}
