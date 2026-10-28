resource "aws_dynamodb_table" "payment_saga" {
  name         = "payment-saga-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "idempotency_key" #tfsec:ignore:aws-dynamodb-table-customer-key

  attribute {
    name = "idempotency_key"
    type = "S"
  }

  attribute {
    name = "order_id"
    type = "S"
  }

  global_secondary_index {
    name            = "order_id-index"
    hash_key        = "order_id"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = {
    Name = "payment-saga-state"
  }
}
