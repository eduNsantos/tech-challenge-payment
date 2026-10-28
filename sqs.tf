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

resource "aws_sqs_queue_policy" "dlq_sns" {
  queue_url = aws_sqs_queue.dlq.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "sns.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.dlq.arn
        Condition = {
          ArnEquals = { "aws:SourceArn" = aws_sns_topic.dlq_notifications.arn }
        }
      }
    ]
  })
}
