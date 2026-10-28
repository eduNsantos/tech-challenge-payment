resource "aws_sns_topic" "dlq_notifications" {
  name = "payment-dlq-notifications"

  tags = {
    Name = "payment-dlq-notifications"
  }
}

# Subscription de exemplo: adicionar e-mail ou endpoint HTTP conforme necessidade
# resource "aws_sns_topic_subscription" "dlq_email" {
#   topic_arn = aws_sns_topic.dlq_notifications.arn
#   protocol  = "email"
#   endpoint  = "ops@example.com"
# }
