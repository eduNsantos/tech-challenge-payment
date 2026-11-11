# tech-challenge-payment-service

Infraestrutura AWS do serviço de pagamento do POS Tech Challenge.
Implementa o padrão **SAGA com Orquestração** usando AWS Step Functions + Mercado Pago.

> Documentação completa da arquitetura: [`docs/saga-architecture.md`](docs/saga-architecture.md)

---

## Arquitetura

```
App/EKS → POST /orders → λ Orders → SQS (payment-orders)
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
                                             → POST callback_url (se presente)
```

---

## Pré-requisitos

| Ferramenta | Versão mínima | Instalação |
|---|---|---|
| Terraform | 1.13.5 | https://developer.hashicorp.com/terraform/install |
| Node.js | 24.x | https://nodejs.org |
| AWS CLI | 2.x | https://aws.amazon.com/cli |
| Credenciais AWS | — | IAM com permissões para Lambda, SQS, DynamoDB, Step Functions, API Gateway, Secrets Manager, SNS, IAM |

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
mp_access_token      = "APP_USR-..."    # Access Token de produção da aplicação do VENDEDOR (ver "Configurar o Mercado Pago")
mp_webhook_secret    = "..."            # Assinatura secreta do Webhook da MESMA aplicação
# app_notification_url = "https://..."  # Opcional — fallback; o application envia notification_url em cada pedido

# Opcionais — back_urls do Checkout Pro (habilita auto_return=approved se success estiver definida)
# checkout_back_url_success = "https://app.example.com/checkout/success"
# checkout_back_url_pending = "https://app.example.com/checkout/pending"
# checkout_back_url_failure = "https://app.example.com/checkout/failure"
```

> **Nunca commite `terraform.tfvars`** — ele está no `.gitignore`.

### 3. Configurar credenciais AWS

```bash
# Via variáveis de ambiente (somem ao fechar o terminal — nada salvo no computador):
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_SESSION_TOKEN="..."   # somente para credenciais temporárias (ex: AWS Academy)
export AWS_DEFAULT_REGION="us-east-1"
```

Verificar acesso:

```bash
aws sts get-caller-identity
```

### 4. Criar o bucket S3 de state via Terraform (bootstrap)

O bucket do Terraform state é criado pelo próprio Terraform — sem AWS CLI, sem console.
O bootstrap usa state local e roda apenas uma vez por conta AWS.
Ao final, ele gera o arquivo `infra/backend.hcl` automaticamente.

```bash
cd infra/bootstrap

terraform init
terraform apply   # confirme com "yes"

# Volta para a raiz
cd ../..
```

Output esperado:
```
bucket_name      = "techchallenge-tfstate-008962119864"
backend_hcl_path = ".../infra/backend.hcl"
```

---

## Deploy

### Deploy via Terraform (local)

```bash
cd infra

# 1. Inicializar providers e backend S3 (passa o bucket via backend.hcl)
terraform init -backend-config=backend.hcl

# 2. Validar sintaxe
terraform validate

# 3. Visualizar o que será criado
terraform plan

# 4. Aplicar
terraform apply
```

Ao final, o Terraform exibe os outputs:

```
orders_url                 = "https://y3qp355i65.execute-api.us-east-1.amazonaws.com/orders"
webhook_url                = "https://y3qp355i65.execute-api.us-east-1.amazonaws.com/webhook"
payment_orders_queue_url   = "https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders"
payment_orders_queue_arn   = "arn:aws:sqs:us-east-1:008962119864:payment-orders"
state_machine_arn          = "arn:aws:states:us-east-1:008962119864:stateMachine:payment-saga"
dynamodb_table_name        = "payment-saga-state"
dlq_url                    = "https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders-dlq"
```

### Deploy via CI/CD (GitHub Actions)

Secrets do repositório (*Settings > Secrets and variables > Actions*):

| Secret | Vira a variável Terraform | Descrição |
|---|---|---|
| `MP_ACCESS_TOKEN` | `mp_access_token` | Access Token `APP_USR-...` da aplicação do vendedor |
| `MP_WEBHOOK_SECRET` | `mp_webhook_secret` | Assinatura secreta do Webhook da mesma aplicação |
| `TF_VAR_app_notification_url` | `app_notification_url` | Opcional — fallback quando a mensagem não traz `notification_url` (o application sempre envia) |

Atualizar via CLI (o valor vai por stdin, não aparece no histórico do shell):

```bash
printf '%s' 'APP_USR-...' | gh secret set MP_ACCESS_TOKEN
printf '%s' '<assinatura>' | gh secret set MP_WEBHOOK_SECRET
```

> `mp_access_token` e `mp_webhook_secret` têm `validation` contra valor vazio: se o secret não existir
> ou estiver com nome errado, o `terraform plan` falha em vez de sobrescrever o Secrets Manager com string vazia.

Comportamento do pipeline:

| Gatilho | O que roda |
|---|---|
| Push na `main` | Apenas **Test** (`npm test`) |
| *Actions > Deploy Payment Service > Run workflow* | **Test** → **Deploy** (`terraform init/plan/apply`) |

O deploy manual pede como inputs `aws_access_key_id`, `aws_secret_access_key` e `aws_session_token`
— copie de *AWS Academy > AWS Details > AWS CLI* (expiram em ~3h; são mascarados no log).
O bucket do Terraform state é derivado automaticamente via `aws sts get-caller-identity`.

---

## Integração com o tech-challenge-application (ordem de deploy)

O application envia `callback_url` e `notification_url` **em cada pedido**, então o payment-service não precisa conhecer a URL do app no deploy. A dependência é de mão única:

```
payment-service ──(api_base_url)──▶ application
application ──(callback_url / notification_url, por mensagem)──▶ payment-service
```

1. **Deploy do payment-service** (este repo, `workflow_dispatch`). O resumo do job mostra:
   - `api_base_url` → base da API (para conferência; o app descobre sozinho)
   - `webhook_url` → configurar no painel do Mercado Pago (uma vez)
2. **Deploy do application** (repo `tech-challenge-kubernetes`, workflow `deploy-eks.yml`). O job `rollout` resolve automaticamente:
   - `PAYMENT_SERVICE_URL` → procura a API Gateway pelo nome **`payment-service-api`** (não renomeie sem ajustar o workflow)
   - `APP_URL` → hostname do ELB do Service `postech-app`. Dele saem `callback_url` e `notification_url`.

Quando reexecutar cada um:

| Mudou | Ação |
|---|---|
| Código/infra do payment-service (API Gateway mantido) | Só redeploy do payment-service |
| API Gateway recriado (`destroy`/lab resetado) | Redeploy do payment-service **e** rodar o `deploy-eks` de novo (redescobre a URL) |
| ELB do app mudou | Só redeploy do app — cobranças **já abertas** perdem o retorno (URL antiga gravada na SAGA) |

## Configurar o Mercado Pago (ambiente de teste)

O Mercado Pago **não aceita misturar conta real com conta de teste** no mesmo pagamento
(erro *"Uma das partes com as quais você está tentando efetuar o pagamento é de teste"*).
Por isso vendedor **e** comprador precisam ser contas de teste, distintas entre si.

### 1. Criar as contas de teste

Logado na sua **conta real**: *Suas integrações > [sua aplicação] > Contas de teste > Criar conta de teste*.

| Conta | Tipo | Uso |
|---|---|---|
| Vendedor | Vendedor, Brasil | Dono das credenciais usadas pela Lambda `generate-link` |
| Comprador | Comprador, Brasil | Login no checkout para pagar |

> **Anote a senha na criação** — ela não é exibida depois e não pode ser consultada via API.
> O código de verificação pedido no login aparece na mesma lista de contas de teste.
> O usuário `TESTUSER<n>` e o e-mail `test_user_<n>@testuser.com` com o mesmo número são a mesma conta.

### 2. Criar a aplicação do vendedor

1. Em uma **janela anônima**, faça login no Mercado Pago com o **vendedor de teste**.
2. *Suas integrações > Criar aplicação* (produto: Checkout Pro).
3. *Credenciais de produção* → copie o **Access Token** (`APP_USR-...`). Sim, é "produção" de uma conta de teste.

Para conferir de qual conta é um token:

```bash
curl -s -H "Authorization: Bearer APP_USR-..." https://api.mercadopago.com/users/me \
  | jq '{id, nickname, tags}'
# esperado: nickname TESTUSER..., tags contendo "test_user"
```

### 3. Configurar o Webhook (na aplicação do vendedor)

*Webhooks > Configurar notificações*:

- **URL de produção:** o output `webhook_url` do Terraform (ex.: `https://y3qp355i65.execute-api.us-east-1.amazonaws.com/webhook`)
- **Eventos:** `Pagamentos`
- Salve e copie a **Assinatura secreta** (64 caracteres hex) — **não** é a URL.

A assinatura é por aplicação: trocou de aplicação, troque também o `MP_WEBHOOK_SECRET`,
senão todo webhook volta `401` e a SAGA fica parada em `WAITING_PAYMENT`.

### 4. Publicar as credenciais

Atualize `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` no GitHub e rode o deploy manual.
Com token `APP_USR-` a Lambda devolve o `init_point` (com `TEST-` devolve o `sandbox_init_point`).

---

## Enviar uma ordem de pagamento

### Via HTTP — POST /orders (recomendado)

O App/EKS envia a ordem via HTTP sem precisar de credenciais AWS:

```bash
curl -X POST "$(terraform -chdir=infra output -raw orders_url)" \
  -H "Content-Type: application/json" \
  -d "{
    \"order_id\":     \"$(uuidgen | tr 'A-Z' 'a-z')\",
    \"created_at\":   \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"amount_cents\": 550,
    \"currency\":     \"BRL\",
    \"description\":  \"Pedido teste\",
    \"customer\": {
      \"name\":  \"Comprador Teste\",
      \"email\": \"test_user_<n>@testuser.com\",
      \"cpf\":   \"12345678909\"
    },
    \"items\": [
      { \"id\": \"PROD-001\", \"title\": \"Lanche\", \"quantity\": 2, \"unit_price_cents\": 250 },
      { \"id\": \"PROD-042\", \"title\": \"Suco\",   \"quantity\": 1, \"unit_price_cents\": 50 }
    ],
    \"callback_url\": \"https://sua-app.com/payments/callback\"
  }"
```

Regras que o Step ① valida (falha → `FAILED` + DLQ):
- `amount_cents` = soma de `quantity × unit_price_cents` dos itens
- `cpf` com dígitos verificadores válidos (`12345678909` é válido para teste)
- Em teste, use valores entre **R$ 5,00 e R$ 6,00** (`amount_cents` 500–600)
- `customer.email` com o e-mail do **comprador de teste** (o checkout pré-preenche o pagador)

Resposta `202 Accepted`:
```json
{ "idempotency_key": "<sha256-gerado>", "order_id": "f47ac10b-...", "status": "QUEUED" }
```

O campo `callback_url` é opcional. Quando presente, o payment-service faz `POST` para essa URL com o resultado final (`PAID` ou `REJECTED`) após o pagamento ser processado pelo Mercado Pago.

> Documentação completa do schema: [`bruno/docs/sqs-message-schema.md`](bruno/docs/sqs-message-schema.md)

### Via SQS direto (alternativo — requer credenciais AWS)

```bash
aws sqs send-message \
  --queue-url "$(terraform -chdir=infra output -raw payment_orders_queue_url)" \
  --message-body '{
    "idempotency_key": "a3f4b2c1d8e7f9004a5b6c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3",
    "order_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "created_at": "2026-10-28T14:32:00Z",
    "amount_cents": 550,
    "currency": "BRL",
    "description": "Pedido de teste",
    "customer": {"name": "Teste", "email": "test_user_<n>@testuser.com", "cpf": "12345678909"},
    "items": [{"id": "P1", "title": "Item", "quantity": 1, "unit_price_cents": 550}]
  }'
```

> Ao enfileirar diretamente no SQS, o `idempotency_key` é **obrigatório** (gerado pelo produtor).

---

## Testar um pagamento de ponta a ponta

1. Envie uma ordem (`POST /orders`, acima) e guarde o `idempotency_key`.
2. Aguarde alguns segundos e pegue o link gerado:

   ```bash
   aws dynamodb get-item --table-name payment-saga-state --consistent-read \
     --key '{"idempotency_key":{"S":"<idempotency_key>"}}' \
     --query 'Item.[status.S, payment_link.S]' --output text
   # esperado: WAITING_PAYMENT  https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=...
   ```

3. Abra o link em uma **janela anônima**, faça login com o **comprador de teste** e pague com um cartão de teste.
4. Confira o resultado: o registro deve ir para `PAID`/`REJECTED`, a execução do Step Functions
   (nome = `idempotency_key`) para `SUCCEEDED`/`FAILED`, e o log da `payment-callback` deve mostrar
   `"event":"mp_webhook_received" ... "signature_valid":true`.

### Cartões de teste (Brasil)

| Bandeira | Número | CVV | Validade |
|---|---|---|---|
| Mastercard | 5031 4332 1540 6351 | 123 | 11/30 |
| Visa | 4235 6477 2802 5682 | 123 | 11/30 |
| American Express | 3753 6515 3556 885 | 1234 | 11/30 |

CPF do titular: `12345678909`. O **nome do titular** define o resultado:

| Nome | Resultado no MP | Status no DynamoDB |
|---|---|---|
| `APRO` | Aprovado | `PAID` |
| `OTHE` | Recusado (erro geral) | `REJECTED` |
| `CONT` | Pendente | permanece `WAITING_PAYMENT` |
| `FUND` | Saldo insuficiente | `REJECTED` |
| `SECU` | CVV inválido | `REJECTED` |

> Lista oficial: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/test/cards

### Back URLs (opcional)

Para redirecionar o comprador após o pagamento, defina `checkout_back_url_success`/`_pending`/`_failure`
no `terraform.tfvars`. Com `success` definida, a preferência usa `auto_return: "approved"`.
As URLs precisam ser HTTPS com DNS — o MP não aceita `localhost`.

---

## Testar o webhook (simulado)

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
# nomes: orders-api, trigger, register, generate-link, notify-wait, cancel, callback
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

### Por que uma saga falhou

```bash
aws stepfunctions get-execution-history \
  --execution-arn "arn:aws:states:us-east-1:<account>:execution:payment-saga:<idempotency_key>" \
  --query 'events[?type==`TaskFailed`].taskFailedEventDetails.[error,cause]' --output text
```

---

## Troubleshooting

| Sintoma | Causa | Solução |
|---|---|---|
| Step ② falha com `403 PA_UNAUTHORIZED_RESULT_FROM_POLICIES` | Access token vazio ou inválido no Secrets Manager | Confira `MP_ACCESS_TOKEN` no GitHub e refaça o deploy; valide o token com `/users/me` |
| Checkout: *"Uma das partes ... é de teste"* | Vendedor real + comprador de teste (ou vice-versa) | Use credenciais `APP_USR-` de um **vendedor de teste** e pague com outro **comprador de teste** |
| Webhook do pagamento com `signature_valid:false` | `MP_WEBHOOK_SECRET` de outra aplicação | Copie a assinatura secreta da aplicação dona do token e refaça o deploy |
| Logs com `data_id:null`, `signature_valid:false` (inclusive `merchant_order`) | Notificações no formato antigo (IPN), sem assinatura | Inofensivo — o MP reenvia por alguns dias; o pagamento chega pelo webhook assinado |
| Saga em `FAILED` logo no Step ① | `amount_cents` ≠ soma dos itens ou CPF inválido | Corrija o payload (ver regras em "Enviar uma ordem de pagamento") |
| Ordem em `WAITING_PAYMENT` indefinidamente | Ninguém pagou o link | Expira em 48h → `EXPIRED` (Step ⑤) |

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
│   ├── orders/index.js           # POST /orders → valida payload + enfileira no SQS
│   ├── trigger/index.js          # Poll SQS → startExecution
│   ├── register/index.js         # Step ① — valida + grava DynamoDB
│   ├── generate-link/index.js    # Step ② — chama Mercado Pago
│   ├── notify-wait/index.js      # Step ③/④ — notifica app + WaitForTaskToken
│   ├── cancel/index.js           # Step ⑤ — cancela gateway + marca EXPIRED
│   └── callback/index.js         # Webhook MP → sendTaskSuccess/Failure + callback_url
├── infra/                        # Infraestrutura Terraform
│   ├── bootstrap/                # Bootstrap: cria bucket S3 de state (roda uma vez)
│   │   └── main.tf
│   ├── providers.tf              # Backend S3 (partial), providers
│   ├── variables.tf
│   ├── data.tf                   # aws_caller_identity
│   ├── network.tf                # (reservado — sem recursos ativos)
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
│   ├── lambda-orders.tf
│   ├── lambda-cancel.tf
│   ├── lambda-callback.tf
│   ├── step-functions.tf         # State machine (ASL inline via jsonencode)
│   ├── apigateway.tf             # HTTP API v2 + POST /orders + POST /webhook
│   ├── outputs.tf
│   ├── terraform.tfvars.example  # Modelo para variáveis (sem valores reais)
│   └── backend.hcl.example       # Modelo para configuração do backend S3
└── .github/workflows/deploy.yml  # CI/CD: test → terraform apply
```

> **`infra/terraform.tfvars`** e **`infra/backend.hcl`** são arquivos locais listados no `.gitignore`
> e nunca devem ser commitados.
