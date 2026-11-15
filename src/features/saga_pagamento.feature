# language: pt
Funcionalidade: SAGA de pagamento orquestrada pelo Step Functions
  Como application da oficina
  Quero cobrar o orçamento da O.S. pelo payment-service
  Para aprovar a O.S. só quando o pagamento for confirmado, com compensação se algo falhar

  Os cenários executam a definição real da máquina de estados (infra/state-machine/payment-saga.asl.json)
  com os handlers reais das Lambdas. DynamoDB, SQS, Step Functions, Secrets Manager, Mercado Pago
  e o application são simulados em memória.

  Contexto:
    Dado que o Mercado Pago está disponível
    E que o application está no ar

  @caminho-feliz
  Cenário: Pagamento aprovado conclui a saga e avisa o application
    Quando o application solicita a cobrança de 600 centavos para o CPF "52998224725"
    Então a API deve aceitar o pedido com status "QUEUED"
    Quando o trigger consome a fila de pedidos
    Então a saga deve ficar aguardando o pagamento
    E o pedido deve estar com status "WAITING_PAYMENT" no DynamoDB
    E o application deve receber o link de pagamento
    Quando o Mercado Pago notifica o pagamento com status "approved"
    Então o webhook deve responder 200
    E a saga deve terminar com sucesso
    E o pedido deve estar com status "PAID" no DynamoDB
    E o application deve receber o resultado "PAID"
    E a saga deve ter passado pelos estados:
      | Registrar          |
      | IniciarTentativas  |
      | GerarLink          |
      | NotificarEAguardar |
      | PagamentoAprovado  |

  @compensacao
  Cenário: Pagamento recusado encerra a saga sem aprovar a O.S.
    Dado uma saga aguardando o pagamento de 600 centavos
    Quando o Mercado Pago notifica o pagamento com status "rejected"
    Então a saga deve terminar com falha "PaymentRejected"
    E o pedido deve estar com status "REJECTED" no DynamoDB
    E o application deve receber o resultado "REJECTED"
    E nenhuma mensagem deve ir para a DLQ

  @compensacao
  Cenário: Sem pagamento dentro do prazo a compensação expira a cobrança
    Dado uma saga aguardando o pagamento de 600 centavos
    Quando o prazo de pagamento se esgota
    Então a saga deve terminar com falha "SagaFailed"
    E o pedido deve estar com status "EXPIRED" no DynamoDB
    E o application deve receber o resultado "EXPIRED"
    E a DLQ deve receber o pedido com o erro "States.HeartbeatTimeout"
    E a saga deve ter passado pelos estados:
      | Registrar          |
      | IniciarTentativas  |
      | GerarLink          |
      | NotificarEAguardar |
      | Cancelar           |
      | EnviarParaDLQ      |
      | SagaFalhou         |

  Cenário: Pagamento pendente (PIX/boleto) mantém a saga aguardando
    Dado uma saga aguardando o pagamento de 600 centavos
    Quando o Mercado Pago notifica o pagamento com status "pending"
    Então o webhook deve responder 200
    E a saga deve ficar aguardando o pagamento
    E o pedido deve estar com status "WAITING_PAYMENT" no DynamoDB
    E o application não deve receber resultado do pagamento

  @falha
  Cenário: Documento inválido falha no registro sem gerar cobrança
    Quando o application solicita a cobrança de 600 centavos para o CPF "11111111111"
    E o trigger consome a fila de pedidos
    Então a saga deve terminar com falha "SagaFailed"
    E o erro registrado na saga deve ser "InvalidDocument"
    E o Mercado Pago não deve ser chamado
    E nenhum pedido deve estar gravado no DynamoDB
    E nenhuma mensagem deve ir para a DLQ

  @retry
  Cenário: Instabilidade curta do Mercado Pago é absorvida pelo Retry do passo GerarLink
    Dado que o Mercado Pago vai falhar nas próximas 2 chamadas
    Quando o application solicita a cobrança de 600 centavos para o CPF "52998224725"
    E o trigger consome a fila de pedidos
    Então a saga deve ficar aguardando o pagamento
    E o Mercado Pago deve ter sido chamado 3 vezes
    E a saga não deve ter aguardado nova tentativa diária

  @retry
  Cenário: Mercado Pago fora do ar no primeiro dia gera o link na nova tentativa diária
    Dado que o Mercado Pago vai falhar nas próximas 4 chamadas
    Quando o application solicita a cobrança de 600 centavos para o CPF "52998224725"
    E o trigger consome a fila de pedidos
    Então a saga deve ficar aguardando o pagamento
    E o Mercado Pago deve ter sido chamado 5 vezes
    E a saga deve ter aguardado 1 nova tentativa diária
    E o application deve receber o link de pagamento

  @retry @falha
  Cenário: Mercado Pago fora do ar em todas as tentativas envia o pedido para a DLQ
    Dado que o Mercado Pago está fora do ar
    Quando o application solicita a cobrança de 600 centavos para o CPF "52998224725"
    E o trigger consome a fila de pedidos
    Então a saga deve terminar com falha "SagaFailed"
    E o Mercado Pago deve ter sido chamado 16 vezes
    E a saga deve ter aguardado 3 novas tentativas diárias
    E a DLQ deve receber o pedido com o erro "MercadoPagoError"
    E o pedido deve estar com status "PENDING" no DynamoDB
    E o application não deve receber o link de pagamento

  @idempotencia
  Cenário: Pedido duplicado não inicia uma segunda saga
    Quando o application solicita a mesma cobrança de 600 centavos 2 vezes
    E o trigger consome a fila de pedidos
    Então apenas 1 saga deve ter sido iniciada
    E o trigger não deve devolver mensagens para a fila

  @seguranca
  Cenário: Webhook com assinatura inválida é rejeitado
    Dado uma saga aguardando o pagamento de 600 centavos
    Quando alguém envia um webhook de pagamento "approved" com assinatura inválida
    Então o webhook deve responder 401
    E a saga deve ficar aguardando o pagamento
    E o pedido deve estar com status "WAITING_PAYMENT" no DynamoDB
