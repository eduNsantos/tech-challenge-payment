output "webhook_url" {
  description = "URL do endpoint de webhook (POST /webhook) para configurar no Mercado Pago"
  value       = "${aws_apigatewayv2_stage.default.invoke_url}webhook"
}

output "api_base_url" {
  description = "Base da API do payment-service — valor de PAYMENT_SERVICE_URL no application"
  value       = trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")
}

output "orders_url" {
  description = "URL do endpoint de criação de ordens (POST /orders) para o App/EKS"
  value       = "${aws_apigatewayv2_stage.default.invoke_url}orders"
}

output "payment_orders_queue_url" {
  description = "URL da fila SQS payment-orders para o App/EKS enfileirar ordens"
  value       = aws_sqs_queue.payment_orders.url
}

output "payment_orders_queue_arn" {
  description = "ARN da fila SQS payment-orders"
  value       = aws_sqs_queue.payment_orders.arn
}

output "dynamodb_table_name" {
  description = "Nome da tabela DynamoDB de estado da SAGA"
  value       = aws_dynamodb_table.payment_saga.name
}

output "state_machine_arn" {
  description = "ARN da state machine do AWS Step Functions"
  value       = aws_sfn_state_machine.payment_saga.arn
}

output "dlq_url" {
  description = "URL da Dead-Letter Queue"
  value       = aws_sqs_queue.dlq.url
}
