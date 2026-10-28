resource "aws_security_group" "lambda" {
  name        = "payment-service-lambda"
  description = "Security group das Lambdas do payment-service"
  vpc_id      = data.aws_vpc.main.id

  tags = {
    Name = "payment-service-lambda"
  }
}

resource "aws_security_group" "secretsmanager_endpoint" {
  name        = "payment-service-secretsmanager-endpoint"
  description = "Security group do VPC endpoint do Secrets Manager para o payment-service"
  vpc_id      = data.aws_vpc.main.id

  tags = {
    Name = "payment-service-secretsmanager-endpoint"
  }
}

# Lambdas precisam de HTTPS para: Mercado Pago API, Step Functions, SNS, DynamoDB
resource "aws_vpc_security_group_egress_rule" "lambda_https_internet" {
  security_group_id = aws_security_group.lambda.id
  description       = "HTTPS para internet (Mercado Pago, Step Functions, SNS, DynamoDB)"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "lambda_to_secretsmanager_endpoint" {
  security_group_id            = aws_security_group.lambda.id
  description                  = "HTTPS para o VPC endpoint do Secrets Manager"
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.secretsmanager_endpoint.id
}

resource "aws_vpc_security_group_ingress_rule" "secretsmanager_endpoint_from_lambda" {
  security_group_id            = aws_security_group.secretsmanager_endpoint.id
  description                  = "HTTPS das Lambdas do payment-service"
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.lambda.id
}

resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = data.aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [data.aws_subnet.sub_a.id, data.aws_subnet.sub_b.id]
  security_group_ids  = [aws_security_group.secretsmanager_endpoint.id]
  private_dns_enabled = true

  tags = {
    Name = "payment-service-secretsmanager"
  }
}
