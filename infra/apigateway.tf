resource "aws_apigatewayv2_api" "payment" {
  name          = "payment-service-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.payment.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_apigatewayv2_integration" "callback" {
  api_id                 = aws_apigatewayv2_api.payment.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.callback.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.payment.id
  route_key = "POST /webhook"
  target    = "integrations/${aws_apigatewayv2_integration.callback.id}"
}
