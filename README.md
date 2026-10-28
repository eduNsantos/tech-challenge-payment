# tech-challenge-payment-service

Infraestrutura AWS do serviço de pagamento do POS Tech Challenge.
Implementa o padrão **SAGA com Orquestração** usando AWS Step Functions + Mercado Pago.

> Documentação completa da arquitetura: [`docs/saga-architecture.md`](docs/saga-architecture.md)

---

## Arquitetura

```
App/EKS → SQS (payment-orders)
              │
              ▼
         λ Trigger (poll SQS, concorrência máx. 5)
              │
              ▼
         Step Functions — SAGA
         ① REGISTRAR   → DynamoDB (PENDING)
         ② GERAR LINK  → Mercado Pago API (retry 3× backoff)
         ③ NOTIFICAR   → App + DynamoDB (WAITING_PAYMENT) + salva task token
         ④ AGUARDAR    → WaitForTaskToken (heartbeat 30min, timeout 48h)
         ⑤ CANCELAR    → Mercado Pago + DynamoDB (EXPIRED) → DLQ → SNS

Mercado Pago → POST /webhook → API Gateway → λ Callback
                                             → valida HMAC-SHA256
                                             → DynamoDB (PAID/REJECTED)
                                             → sendTaskSuccess/Failure
```

---

## Pré-requisitos

| Ferramenta | Versão mínima | Instalação |
|---|---|---|
| Terraform | 1.13.5 | https://developer.hashicorp.com/terraform/install |
| Node.js | 24.x | https://nodejs.org |
| AWS CLI | 2.x | https://aws.amazon.com/cli |
| Credenciais AWS | — | IAM com permissões para Lambda, SQS, DynamoDB, Step Functions, API Gateway, Secrets Manager, SNS, IAM, VPC |

---

## Configuração inicial

### 1. Clonar e instalar dependências Node.js

```bash
git clone <url-do-repo>
cd tech-challenge-payment-service

cd src
npm install
cd ..
```

### 2. Configurar variáveis Terraform

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

Editar `infra/terraform.tfvars` com os valores reais:

```hcl
mp_access_token      = "APP_USR-..."    # Painel MP > Configurações > Credenciais de produção
mp_webhook_secret    = "..."            # Painel MP > Configurações > Notificações > Chave secreta
app_notification_url = "https://..."   # URL interna do App/EKS para receber o link de pagamento
```

> **Nunca commite `terraform.tfvars`** — ele está no `.gitignore`.

### 3. Configurar credenciais AWS

```bash
aws configure
# ou via variáveis de ambiente:
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_DEFAULT_REGION="us-east-1"
```

Verificar acesso:

```bash
aws sts get-caller-identity
```

---

## Deploy

### Deploy via Terraform (local)

```bash
cd infra

# 1. Inicializar providers e backend S3
terraform init

# 2. Validar sintaxe
terraform validate

# 3. Visualizar o que será criado
terraform plan

# 4. Aplicar
terraform apply
```

Ao final, o Terraform exibe os outputs:

```
webhook_url                = "https://xxx.execute-api.us-east-1.amazonaws.com/webhook"
payment_orders_queue_url   = "https://sqs.us-east-1.amazonaws.com/477478162709/payment-orders"
payment_orders_queue_arn   = "arn:aws:sqs:us-east-1:477478162709:payment-orders"
state_machine_arn          = "arn:aws:states:us-east-1:477478162709:stateMachine:payment-saga"
dynamodb_table_name        = "payment-saga-state"
dlq_url                    = "https://sqs.us-east-1.amazonaws.com/477478162709/payment-orders-dlq"
```

### Deploy via CI/CD (GitHub Actions)

Adicionar os seguintes secrets no repositório GitHub:

| Secret | Descrição |
|---|---|
| `AWS_ACCESS_KEY_ID` | Chave de acesso AWS |
| `AWS_SECRET_ACCESS_KEY` | Chave secreta AWS |
| `TF_VAR_mp_access_token` | Access token do Mercado Pago |
| `TF_VAR_mp_webhook_secret` | Secret do webhook do Mercado Pago |
| `TF_VAR_app_notification_url` | URL do App/EKS para notificação |

O pipeline executa automaticamente no push para `main`:
1. **Test** — `npm test` nos handlers Lambda
2. **Deploy** — Terraform init → plan → apply

---

## Pós-deploy: configurar o Mercado Pago

Após o `terraform apply`, copie o valor de `webhook_url` e configure no painel do Mercado Pago:

**Painel MP > Configurações > Notificações > URL de notificações**

```
https://xxx.execute-api.us-east-1.amazonaws.com/webhook
```

Marcar os eventos: `Pagamentos`.

---

## Enviar uma ordem de pagamento

O App/EKS envia uma mensagem para a fila SQS `payment-orders`. Formato:

```json
{
  "idempotency_key": "<sha256(order_id|amount_cents|created_at)>",
  "order_id":        "<uuid-v4>",
  "created_at":      "2026-10-28T14:32:00Z",
  "amount_cents":    15000,
  "currency":        "BRL",
  "description":     "Pedido #4872",
  "customer": {
    "name":  "João da Silva",
    "email": "joao@email.com",
    "cpf":   "12345678901"
  },
  "items": [
    { "id": "PROD-001", "title": "Lanche", "quantity": 2, "unit_price_cents": 7500 }
  ]
}
```

> Documentação completa do schema: [`bruno/docs/sqs-message-schema.md`](bruno/docs/sqs-message-schema.md)

### Envio manual via AWS CLI (teste)

```bash
aws sqs send-message \
  --queue-url "$(terraform output -raw payment_orders_queue_url)" \
  --message-body '{
    "idempotency_key": "a3f4b2c1d8e7f9004a5b6c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3",
    "order_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "created_at": "2026-10-28T14:32:00Z",
    "amount_cents": 15000,
    "currency": "BRL",
    "description": "Pedido de teste",
    "customer": {"name": "Teste", "email": "teste@email.com", "cpf": "12345678901"},
    "items": [{"id": "P1", "title": "Item", "quantity": 1, "unit_price_cents": 15000}]
  }'
```

---

## Testar o webhook

A collection Bruno em `bruno/` contém 3 cenários prontos:
- `mp-payment-approved.bru` — pagamento aprovado → `sendTaskSuccess`
- `mp-payment-rejected.bru` — pagamento rejeitado → `sendTaskFailure`
- `mp-payment-pending.bru` — PIX/boleto pendente → mantém WaitForTaskToken ativo

Abra a pasta `bruno/` no [Bruno](https://www.usebruno.com/) como collection.

---

## Monitoramento

### Verificar estado de uma saga no DynamoDB

```bash
aws dynamodb get-item \
  --table-name payment-saga-state \
  --key '{"idempotency_key": {"S": "<chave>"}}' \
  --output json | jq '.Item.status.S'
```

### Logs da Lambda Trigger

```bash
aws logs tail /aws/lambda/payment-trigger --follow
```

### Logs de qualquer Lambda

```bash
aws logs tail /aws/lambda/payment-<nome> --follow
# nomes: trigger, register, generate-link, notify-wait, cancel, callback
```

### Execuções do Step Functions

```bash
aws stepfunctions list-executions \
  --state-machine-arn "$(terraform output -raw state_machine_arn)" \
  --query 'executions[*].{name:name,status:status,start:startDate}' \
  --output table
```

### Mensagens na DLQ

```bash
aws sqs receive-message \
  --queue-url "$(terraform output -raw dlq_url)" \
  --max-number-of-messages 10 \
  --output json | jq '.Messages[].Body | fromjson | {order_id, status, error}'
```

---

## Destruir a infraestrutura

```bash
# Destruir recurso específico
terraform destroy -target=aws_lambda_function.trigger

# Destruir tudo (pede confirmação)
terraform destroy
```

> **Atenção:** os secrets no Secrets Manager têm `recovery_window_in_days = 30`. Para destruir e recriar imediatamente, o CI/CD faz o restore automático via `aws secretsmanager restore-secret`.

---

## Estrutura do repositório

```
tech-challenge-payment-service/
├── docs/
│   └── saga-architecture.md     # Documentação da arquitetura SAGA
├── bruno/                        # Collection Bruno para testes de API
│   ├── bruno.json
│   ├── docs/sqs-message-schema.md
│   ├── environments/
│   └── webhook/
├── src/                          # Handlers Lambda (Node.js 24.x)
│   ├── package.json
│   ├── trigger/index.js          # Poll SQS → startExecution
│   ├── register/index.js         # Step ① — valida + grava DynamoDB
│   ├── generate-link/index.js    # Step ② — chama Mercado Pago
│   ├── notify-wait/index.js      # Step ③/④ — notifica app + WaitForTaskToken
│   ├── cancel/index.js           # Step ⑤ — cancela gateway + marca EXPIRED
│   └── callback/index.js         # Webhook MP → sendTaskSuccess/Failure
├── infra/                        # Infraestrutura Terraform
│   ├── providers.tf              # Backend S3, providers
│   ├── variables.tf
│   ├── data.tf                   # VPC, subnets (compartilhados com EKS)
│   ├── network.tf                # Security groups, VPC endpoint Secrets Manager
│   ├── sqs.tf                    # Fila payment-orders + DLQ
│   ├── dynamodb.tf               # Tabela payment-saga-state + GSI + TTL
│   ├── sns.tf                    # Tópico payment-dlq-notifications
│   ├── secrets.tf                # mp-access-token + mp-webhook-secret
│   ├── iam.tf                    # Assume role policy + role Step Functions
│   ├── lambda-build.tf           # null_resource (npm ci) + archive_file
│   ├── lambda-trigger.tf
│   ├── lambda-register.tf
│   ├── lambda-generate-link.tf
│   ├── lambda-notify-wait.tf
│   ├── lambda-cancel.tf
│   ├── lambda-callback.tf
│   ├── step-functions.tf         # State machine (ASL inline via jsonencode)
│   ├── apigateway.tf             # HTTP API v2 + POST /webhook
│   ├── outputs.tf
│   └── terraform.tfvars.example
└── .github/workflows/deploy.yml  # CI/CD: test → terraform apply
```
