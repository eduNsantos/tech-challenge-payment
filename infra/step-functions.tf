resource "aws_sfn_state_machine" "payment_saga" {
  name     = "payment-saga"
  role_arn = data.aws_iam_role.lab_role.arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment = "SAGA orquestrada para processamento de pagamento via Mercado Pago"
    StartAt = "Registrar"
    States = {
      Registrar = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName    = aws_lambda_function.register.arn
          "Payload.$"     = "$"
        }
        ResultPath = null
        Retry = [
          {
            ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
            IntervalSeconds = 2
            MaxAttempts     = 3
            BackoffRate     = 2
          }
        ]
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            Next        = "SagaFalhou"
            ResultPath  = "$.error"
          }
        ]
        Next = "GerarLink"
      }

      GerarLink = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.generate_link.arn
          "Payload.$"  = "$"
        }
        ResultPath = "$.payment_link"
        Retry = [
          {
            ErrorEquals     = ["States.ALL"]
            IntervalSeconds = 1
            MaxAttempts     = 3
            BackoffRate     = 2
            MaxDelaySeconds = 10
          }
        ]
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            Next        = "EnviarParaDLQ"
            ResultPath  = "$.error"
          }
        ]
        Next = "NotificarEAguardar"
      }

      NotificarEAguardar = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke.waitForTaskToken"
        Parameters = {
          FunctionName = aws_lambda_function.notify_wait.arn
          Payload = {
            "taskToken.$" = "$$.Task.Token"
            "input.$"     = "$"
          }
        }
        HeartbeatSeconds = 1800
        TimeoutSeconds   = 172800
        ResultPath       = "$.callback_result"
        Catch = [
          {
            ErrorEquals = ["States.HeartbeatTimeout", "States.Timeout"]
            Next        = "Cancelar"
            ResultPath  = "$.error"
          },
          {
            ErrorEquals = ["PaymentRejected"]
            Next        = "PagamentoRejeitado"
            ResultPath  = "$.error"
          }
        ]
        Next = "PagamentoAprovado"
      }

      Cancelar = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.cancel.arn
          "Payload.$"  = "$"
        }
        ResultPath = null
        Next       = "EnviarParaDLQ"
      }

      EnviarParaDLQ = {
        Type     = "Task"
        Resource = "arn:aws:states:::sqs:sendMessage"
        Parameters = {
          QueueUrl     = aws_sqs_queue.dlq.url
          "MessageBody.$" = "States.JsonToString($)"
        }
        ResultPath = null
        Next       = "SagaFalhou"
      }

      PagamentoAprovado = {
        Type = "Succeed"
      }

      PagamentoRejeitado = {
        Type  = "Fail"
        Error = "PaymentRejected"
        Cause = "Pagamento rejeitado pelo gateway de pagamento"
      }

      SagaFalhou = {
        Type  = "Fail"
        Error = "SagaFailed"
        Cause = "SAGA encerrada com falha definitiva"
      }
    }
  })

  tags = {
    Name = "payment-saga"
  }
}
