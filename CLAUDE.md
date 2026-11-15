# CLAUDE.md — tech-challenge-payment-service

## O que é este projeto

Serviço de pagamento serverless que implementa **SAGA com Orquestração** via AWS Step Functions + Mercado Pago.
Tech Challenge FIAP POS — infraestrutura provisionada em Terraform, Lambdas em Node.js 24.x.

## Arquitetura

```
App/EKS → POST /orders → API Gateway v2 → λ payment-orders-api  (src/orders/)
                                               → valida payload
                                               → gera idempotency_key (SHA-256)
                                               → SQS payment-orders
                                                       ↓
                                              λ payment-trigger  (máx 5 concorrentes, poll SQS → StartExecution)
                                                       ↓
                                              Step Functions — SAGA "payment-saga"
                                              ① Registrar     → DynamoDB PENDING           (src/register/)
                                              ② GerarLink     → Mercado Pago API            (src/generate-link/)
                                              ③ NotificarApp  → HTTP POST em notification_url (fallback APP_NOTIFICATION_URL) + DynamoDB WAITING_PAYMENT  (src/notify-wait/)
                                              ④ Aguardar      → WaitForTaskToken (30min heartbeat, 48h timeout)
                                              ⑤ Cancelar      → MP best-effort + DynamoDB EXPIRED + POST callback_url (EXPIRED) → DLQ → SNS  (src/cancel/)

Mercado Pago → POST /webhook → API Gateway v2 → λ payment-callback
                                               → valida HMAC-SHA256 (Secrets Manager)
                                               → GSI order_id-index → task_token
                                               → sendTaskSuccess / sendTaskFailure
                                               → POST callback_url (best-effort, se presente)
```

### Estados DynamoDB (`payment-saga-state`)
```
PENDING → WAITING_PAYMENT → PAID
                          → REJECTED
                          → EXPIRED  (timeout 48h → Step ⑤)
        → FAILED          (Step ② esgotou 3 tentativas)
```

## Stack

| Camada | Tecnologia |
|---|---|
| Linguagem | Node.js 24.x |
| Infra | Terraform ≥ 1.13.5 |
| Cloud | AWS (us-east-1) — Account `008962119864` |
| Banco | DynamoDB `payment-saga-state` (PAY_PER_REQUEST, GSI `order_id-index`) |
| Fila | SQS `payment-orders` + DLQ `payment-orders-dlq` |
| Orquestrador | Step Functions STANDARD `payment-saga` |
| Webhook | API Gateway v2 HTTP `POST /webhook` |
| Secrets | Secrets Manager: `payment/mp-access-token`, `payment/mp-webhook-secret` |

## Estrutura de arquivos

```
src/
  orders/index.js         # POST /orders → valida payload, gera idempotency_key, enfileira SQS
  trigger/index.js        # Poll SQS → StartExecution
  register/index.js       # Step ① — valida CPF ou CNPJ (customer.cpf) e amounts, DynamoDB PENDING
  generate-link/index.js  # Step ② — cria preferência no Mercado Pago
  notify-wait/index.js    # Step ③/④ — salva task token, notifica app
  cancel/index.js         # Step ⑤ — cancela no MP, marca EXPIRED
  callback/index.js       # Webhook MP → resolve Step Functions + notifica callback_url
  lib/monitoring.js       # recordSagaEvent → custom event PaymentSaga no New Relic (no-op sem a layer)
  package.json

infra/
  bootstrap/main.tf       # Cria bucket S3 de state (roda 1× por conta)
  providers.tf            # Backend S3 partial + providers
  variables.tf
  data.tf                 # aws_caller_identity
  iam.tf                  # Apenas data source da LabRole (sem criar roles)
  dynamodb.tf
  sqs.tf
  sns.tf
  secrets.tf
  lambda-build.tf         # null_resource npm ci + archive_file
  lambda-orders.tf
  lambda-trigger.tf
  lambda-register.tf
  lambda-generate-link.tf
  lambda-notify-wait.tf
  lambda-cancel.tf
  lambda-callback.tf
  step-functions.tf       # ASL inline via jsonencode
  apigateway.tf           # HTTP API v2 + POST /orders + POST /webhook
  monitoring.tf           # New Relic: layer + env vars + secret da license key (opcional)
  network.tf              # reservado — sem recursos ativos
  outputs.tf

bruno/                    # Collection para testes do webhook
docs/                     # Arquitetura SAGA, monitoring.md, newrelic-dashboard.json
```

## Constraints críticos

### AWS Academy — LabRole
O ambiente AWS Academy **bloqueia `iam:CreateRole` via SCP**. Nenhuma IAM role pode ser criada.
Toda a infra usa a role pré-existente `LabRole`:
```hcl
data "aws_iam_role" "lab_role" {
  name = "LabRole"
}
# Uso: role = data.aws_iam_role.lab_role.arn
```
**Nunca sugerir `aws_iam_role`, `aws_iam_role_policy` ou `aws_iam_role_policy_attachment`.**

### Backend Terraform
- Bucket S3: `techchallenge-tfstate-008962119864`
- Key: `payment-service/terraform.tfstate`
- Arquivo local (gitignore): `infra/backend.hcl`

### Secrets Manager com `recovery_window_in_days = 30`
Para destruir e recriar imediatamente, o CI faz `aws secretsmanager restore-secret` primeiro.

## CI/CD (GitHub Actions)

Secrets necessários no repositório:
```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
MP_ACCESS_TOKEN            # → TF_VAR_mp_access_token
MP_WEBHOOK_SECRET          # → TF_VAR_mp_webhook_secret
TF_VAR_app_notification_url  # opcional — fallback; o app envia notification_url em cada mensagem
NEW_RELIC_LICENSE_KEY      # opcional — junto com NEW_RELIC_ACCOUNT_ID liga o monitoramento (mesmos nomes do repo kubernetes)
NEW_RELIC_ACCOUNT_ID       # layer ARN é fixado em infra/variables.tf (newrelic_layer_arn)
```
Push para `main` roda só `npm test`. Deploy (`terraform plan/apply`) só via `workflow_dispatch` (credenciais Academy expiram).
As variáveis `mp_access_token`/`mp_webhook_secret` têm `validation` contra valor vazio — evita sobrescrever os secrets com string vazia.

## Monitoramento — New Relic

- Layer pública `NewRelicNodeJS24X:<versão>` (conta AWS `451483290750`), versão fixada no default de `newrelic_layer_arn` (`infra/variables.tf`). Atualizar: `curl -s "https://us-east-1.layers.newrelic-external.com/get-layers?CompatibleRuntime=nodejs24.x"`.
- `infra/monitoring.tf`: `local.newrelic_enabled` só é true com license key **e** account ID. Desligado → sem layer, handler original, secret não criado.
- Toda Lambda nova precisa do padrão: `handler = local.newrelic_enabled ? local.newrelic_wrapper_handler : "<dir>/index.handler"`, `layers = local.newrelic_layers` e `environment.variables = merge({...}, local.newrelic_env, local.newrelic_enabled ? { NEW_RELIC_LAMBDA_HANDLER = "<dir>/index.handler" } : {})`.
- Conta New Relic: `8497993`. A license key é a mesma dos repos `tech-challenge-application`/`tech-challenge-kubernetes`.
- **Sem integração AWS do New Relic** (exige `iam:CreateRole`): as Lambdas não viram entidade em *APM & Services*. Validar sempre por NRQL (`FROM PaymentSaga`, `FROM Log`).
- **A extensão envia a telemetria na invocação seguinte da mesma instância.** Eventos "faltando" logo após um teste costumam ser atraso, não bug. Para forçar o envio: `POST /orders` com `{}` (400) e `POST /webhook` sem assinatura (401). Nenhum dos dois altera estado.
- Não há como consultar o New Relic daqui: a license key só envia dados. Para ler é preciso uma User key (`NRAK-...`), ou o usuário roda a NRQL e manda print.

## Testes de pagamento (Mercado Pago)

- O `callback` busca o pagamento real em `GET /v1/payments/{id}`: webhook com `data.id` fictício (exemplos do Bruno) responde **502**, não `PAID`.
- Para simular `PAID`/`REJECTED` de verdade: pagar o link com os cartões de teste (titular `APRO` = aprovado; `OTHE`/`FUND` = recusado) ou usar o **simulador de Webhooks do painel do MP** com o ID real do pagamento.
- **O ID do API Gateway muda quando ele é recriado.** Se o MP aprova e nada chega (nenhum `mp_webhook_received` nos logs), a URL do webhook no painel do MP está desatualizada.

## Campos `notification_url` e `callback_url` na mensagem SQS

Ambos são enviados pelo application em cada pedido — por isso o deploy do payment-service **não depende** da URL do app (sem dependência circular). `notification_url` recebe o link de pagamento no Step ③; `callback_url` recebe o resultado final.

Campo opcional na mensagem SQS. Quando presente, o `callback/index.js` faz POST para essa URL após processar o webhook do MP (PAID ou REJECTED) e o `cancel/index.js` faz POST com status EXPIRED no timeout, com o payload refletindo o registro completo do DynamoDB.
Ver schema completo em `bruno/docs/sqs-message-schema.md`.

## Padrões do projeto

- Todos os Lambda handlers exportam `exports.handler` (CommonJS)
- Clientes AWS (`DynamoDBClient`, `SFNClient`, etc.) instanciados no escopo do módulo (reutiliza conexão entre invocações)
- Secrets são buscados com cache via variável de módulo (`let cached...`)
- Idempotência: `idempotency_key = SHA-256(order_id|amount_cents|created_at)` — gerado pelo produtor
- O `idempotency_key` é o `name` da execução no Step Functions (rejeição nativa de duplicatas)
- Monitoramento: `require('../lib/monitoring')` + `recordSagaEvent(step, status, attrs)` — nunca enviar dados pessoais. O pacote `newrelic` vem da layer, não do package.json. Ver `docs/monitoring.md`
