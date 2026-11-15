resource "aws_sqs_queue" "dlq" {
  name                      = "payment-orders-dlq"
  message_retention_seconds = 1209600 # 14 dias

  tags = {
    Name = "payment-orders-dlq"
  }
}

resource "aws_sqs_queue" "payment_orders" {
  name                       = "payment-orders"
  visibility_timeout_seconds = 300 # maior que o timeout da lambda-trigger (60s) * max batch size

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    Name = "payment-orders"
  }
}
