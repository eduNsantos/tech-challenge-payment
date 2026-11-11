# Skills — tech-challenge-payment-service

Playbooks para o Claude Code neste repositório. O contexto completo do projeto está em `CLAUDE.md`.

---

## terraform-workflow

Fluxo padrão para qualquer alteração de infraestrutura Terraform.

**Quando usar:** criar, alterar ou destruir recursos AWS via Terraform.

**Pré-requisito:** exportar credenciais AWS no terminal:
```bash
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_SESSION_TOKEN="..."        # apenas AWS Academy (credenciais temporárias)
export AWS_DEFAULT_REGION="us-east-1"
```

**Passos (dentro de `infra/`):**

```bash
# 1. Init com backend S3
terraform init -backend-config=backend.hcl -reconfigure

# 2. Validar sintaxe
terraform validate

# 3. Plan — revisar SEMPRE antes de aplicar
terraform plan -out=tfplan

# 4. Apply
terraform apply tfplan

# 5. Ver outputs (URLs, ARNs, etc.)
terraform output
```

**Nunca** usar `terraform apply -auto-approve` localmente — apenas em CI.

---

## add-lambda

Adiciona uma nova função Lambda ao payment-service.

**Quando usar:** criar um novo handler (ex: status de pagamento, reprocessamento, etc.).

**Constraint obrigatório:** AWS Academy bloqueia `iam:CreateRole`. Usar sempre `data.aws_iam_role.lab_role.arn` como role (já declarado em `infra/iam.tf`).

**Checklist:**

- [ ] Criar `src/{nome}/index.js` com `exports.handler = async (event) => {...}`
- [ ] Se precisar de dependências além das já instaladas, adicionar em `src/package.json`
- [ ] Criar `infra/lambda-{nome}.tf` com o template abaixo
- [ ] Rodar `terraform-workflow` completo

**Template `infra/lambda-{nome}.tf`:**

```hcl
resource "aws_lambda_function" "{nome}" {
  function_name    = "payment-{nome}"
  role             = data.aws_iam_role.lab_role.arn   # LabRole — AWS Academy
  runtime          = "nodejs24.x"
  handler          = "{nome}/index.handler"
  filename         = data.archive_file.payment_lambdas.output_path
  source_code_hash = data.archive_file.payment_lambdas.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      DYNAMODB_TABLE = aws_dynamodb_table.payment_saga.name
      # adicionar outras vars conforme necessário
    }
  }
}
```

> O arquivo ZIP é compartilhado — gerado em `infra/lambda-build.tf` via `archive_file.payment_lambdas`.
> O novo handler é incluído automaticamente porque `source_dir = "${path.module}/../src"`.

**Se a Lambda for exposta via API Gateway**, ver skill `add-apigateway-route`.

---

## add-apigateway-route

Adiciona nova rota ao API Gateway v2 HTTP existente (`aws_apigatewayv2_api.payment`).

**Quando usar:** expor novo endpoint HTTP da Lambda via API Gateway.

```hcl
resource "aws_apigatewayv2_integration" "{nome}" {
  api_id                 = aws_apigatewayv2_api.payment.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.{nome}.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "{nome}" {
  api_id    = aws_apigatewayv2_api.payment.id
  route_key = "POST /{path}"   # ex: "GET /payment/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.{nome}.id}"
}

resource "aws_lambda_permission" "apigateway_{nome}" {
  statement_id  = "AllowAPIGatewayInvoke{Nome}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.{nome}.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.payment.execution_arn}/*/*"
}
```

O stage `$default` tem `auto_deploy = true` — sem redeploy manual após `terraform apply`.

---

## aws-ops

Diagnóstico e inspeção dos recursos AWS do payment-service.

### Identidade e contexto

```bash
aws sts get-caller-identity

# Listar Lambdas do payment-service
aws lambda list-functions \
  --query 'Functions[?starts_with(FunctionName, `payment`)].{Nome:FunctionName,Timeout:Timeout}' \
  --output table
```

### Logs das Lambdas

Nomes: `payment-trigger`, `payment-register`, `payment-generate-link`, `payment-notify-wait`, `payment-cancel`, `payment-callback`

```bash
# Stream ao vivo
aws logs tail /aws/lambda/payment-{nome} --follow

# Buscar erros
aws logs filter-log-events \
  --log-group-name /aws/lambda/payment-{nome} \
  --filter-pattern "ERROR"
```

### Step Functions

```bash
# Listar execuções
aws stepfunctions list-executions \
  --state-machine-arn "$(cd infra && terraform output -raw state_machine_arn)" \
  --query 'executions[*].{name:name,status:status,start:startDate}' \
  --output table

# Detalhar execução específica
aws stepfunctions describe-execution \
  --execution-arn "arn:aws:states:us-east-1:477478162709:execution:payment-saga:{idempotency_key}"
```

### DynamoDB — verificar estado de uma saga

```bash
aws dynamodb get-item \
  --table-name payment-saga-state \
  --key '{"idempotency_key": {"S": "{chave}"}}' \
  --output json | jq '.Item | {status: .status.S, order_id: .order_id.S, updated_at: .updated_at.S}'
```

### SQS — enviar mensagem de teste

```bash
aws sqs send-message \
  --queue-url "$(cd infra && terraform output -raw payment_orders_queue_url)" \
  --message-body '{
    "idempotency_key": "aabbcc112233aabbcc112233aabbcc112233aabbcc112233aabbcc1122334455",
    "order_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "created_at": "2026-01-01T00:00:00Z",
    "amount_cents": 15000,
    "currency": "BRL",
    "description": "Pedido de teste",
    "customer": {"name": "Teste", "email": "teste@email.com", "cpf": "52998224725"},
    "items": [{"id": "P1", "title": "Item", "quantity": 1, "unit_price_cents": 15000}],
    "callback_url": "https://app.example.com/payments/webhook/result"
  }'

# callback_url é opcional — quando presente, o payment-service faz POST para essa URL
# com o resultado final (PAID/REJECTED) após receber o webhook do Mercado Pago.
```

### DLQ — ver mensagens com falha

```bash
aws sqs receive-message \
  --queue-url "$(cd infra && terraform output -raw dlq_url)" \
  --max-number-of-messages 10 \
  --output json | jq '.Messages[].Body | fromjson | {order_id, status, error}'
```

### Secrets Manager

```bash
# Ver access token do Mercado Pago
aws secretsmanager get-secret-value \
  --secret-id payment/mp-access-token \
  --query SecretString --output text | jq .

# Ver webhook secret
aws secretsmanager get-secret-value \
  --secret-id payment/mp-webhook-secret \
  --query SecretString --output text | jq .
```

---

## test-full-flow

Suíte de testes completa do payment-service cobrindo toda a SAGA.

**Quando usar:** validar o serviço após deploy ou alteração de código. Cobre SQS → Step Functions → DynamoDB → Webhook.

**Ambiente implantado (account 008962119864, us-east-1):**
```
SQS URL   : https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders
DLQ URL   : https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders-dlq
DynamoDB  : payment-saga-state
SM Arn    : arn:aws:states:us-east-1:008962119864:stateMachine:payment-saga
Webhook   : https://y3qp355i65.execute-api.us-east-1.amazonaws.com/webhook
```

**Pré-requisito — credenciais AWS:**
```bash
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_SESSION_TOKEN="..."
export AWS_DEFAULT_REGION="us-east-1"
```

---

### Como gerar o idempotency_key

O `idempotency_key` é SHA-256 de `order_id|amount_cents|created_at` (pipe literal):
```bash
echo -n "f47ac10b-58cc-4372-a567-0e02b2c3d479|15000|2026-11-10T10:00:00Z" | sha256sum
# ou em Node.js
node -e "const c=require('crypto'); console.log(c.createHash('sha256').update('f47ac10b-58cc-4372-a567-0e02b2c3d479|15000|2026-11-10T10:00:00Z').digest('hex'))"
```

### CPF de teste válido (algoritmo Receita Federal)

`52998224725` — validado. Use sempre este nas mensagens de teste.

---

### Cenário 1 — Fluxo feliz (SQS → PENDING → WAITING_PAYMENT)

```bash
# 1. Gerar chave de idempotência
IKEY=$(node -e "const c=require('crypto'); console.log(c.createHash('sha256').update('f47ac10b-58cc-4372-a567-0e02b2c3d479|15000|2026-11-10T10:00:00Z').digest('hex'))")

# 2. Enviar mensagem à fila
aws sqs send-message \
  --queue-url "https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders" \
  --message-body "{
    \"idempotency_key\": \"$IKEY\",
    \"order_id\": \"f47ac10b-58cc-4372-a567-0e02b2c3d479\",
    \"created_at\": \"2026-11-10T10:00:00Z\",
    \"amount_cents\": 15000,
    \"currency\": \"BRL\",
    \"description\": \"Teste SAGA — Lanche + Suco\",
    \"customer\": {\"name\": \"João da Silva\", \"email\": \"joao.silva@email.com\", \"cpf\": \"52998224725\", \"phone\": \"+5511999999999\"},
    \"items\": [{\"id\": \"PROD-001\", \"title\": \"Lanche Artesanal\", \"quantity\": 2, \"unit_price_cents\": 5000}, {\"id\": \"PROD-042\", \"title\": \"Suco Natural 500ml\", \"quantity\": 1, \"unit_price_cents\": 5000}],
    \"metadata\": {\"source_service\": \"pos-application\"},
    \"callback_url\": \"https://webhook.site/SUBSTITUA-UUID-AQUI\"
  }"

# 3. Aguardar ~10s e verificar DynamoDB
sleep 10
aws dynamodb get-item \
  --table-name payment-saga-state \
  --key "{\"idempotency_key\": {\"S\": \"$IKEY\"}}" \
  --output json | jq '.Item | {status:.status.S, order_id:.order_id.S, payment_link:.payment_link.S}'
# Esperado: status = "WAITING_PAYMENT", payment_link preenchido
```

---

### Cenário 2 — CPF inválido (Step ① aborta)

```bash
# CPF com dígito errado → validateCpf() retorna false → erro InvalidCPF → SAGA falha
IKEY2=$(node -e "const c=require('crypto'); console.log(c.createHash('sha256').update('aaaabbbb-0000-1111-2222-333344445555|5000|2026-11-10T11:00:00Z').digest('hex'))")
aws sqs send-message \
  --queue-url "https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders" \
  --message-body "{\"idempotency_key\":\"$IKEY2\",\"order_id\":\"aaaabbbb-0000-1111-2222-333344445555\",\"created_at\":\"2026-11-10T11:00:00Z\",\"amount_cents\":5000,\"currency\":\"BRL\",\"description\":\"Teste CPF inválido\",\"customer\":{\"name\":\"Teste\",\"email\":\"t@t.com\",\"cpf\":\"00000000000\"},\"items\":[{\"id\":\"X\",\"title\":\"Item\",\"quantity\":1,\"unit_price_cents\":5000}]}"
# Step Functions vai para FAILED — verificar na console ou:
aws stepfunctions list-executions \
  --state-machine-arn "arn:aws:states:us-east-1:008962119864:stateMachine:payment-saga" \
  --status-filter FAILED --max-results 3 --output table
```

---

### Cenário 3 — amount_cents inconsistente (Step ① aborta)

```bash
# items somam 10000, amount_cents = 15000 → ValidationError
IKEY3=$(node -e "const c=require('crypto'); console.log(c.createHash('sha256').update('ccccdddd-0000-1111-2222-333344445555|15000|2026-11-10T12:00:00Z').digest('hex'))")
aws sqs send-message \
  --queue-url "https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders" \
  --message-body "{\"idempotency_key\":\"$IKEY3\",\"order_id\":\"ccccdddd-0000-1111-2222-333344445555\",\"created_at\":\"2026-11-10T12:00:00Z\",\"amount_cents\":15000,\"currency\":\"BRL\",\"description\":\"Teste valor errado\",\"customer\":{\"name\":\"Teste\",\"email\":\"t@t.com\",\"cpf\":\"52998224725\"},\"items\":[{\"id\":\"X\",\"title\":\"Item\",\"quantity\":1,\"unit_price_cents\":10000}]}"
```

---

### Cenário 4 — Idempotência (mensagem duplicada)

```bash
# Reenviar a mesma mensagem do Cenário 1 (mesmo IKEY)
# DynamoDB: ConditionExpression attribute_not_exists(idempotency_key) → falha silenciosa
# Step Functions: já existe execução com esse name → rejeita (ExecutionAlreadyExists)
aws sqs send-message \
  --queue-url "https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders" \
  --message-body "{\"idempotency_key\":\"$IKEY\", ...mesmo payload do cenário 1...}"
# Verificar: DynamoDB continua com mesmo status, nenhuma nova execução criada
```

---

### Cenário 5 — Webhook com assinatura inválida (401)

```bash
curl -s -w "\n%{http_code}" -X POST \
  "https://y3qp355i65.execute-api.us-east-1.amazonaws.com/webhook" \
  -H "Content-Type: application/json" \
  -H "x-signature: ts=1234567890,v1=assinaturainvalida" \
  -H "x-request-id: req-test-invalid" \
  -d '{"type":"payment","data":{"id":"12345678"}}'
# Esperado: 401 {"message":"Assinatura invalida"}
```

---

### Cenário 6 — Webhook com assinatura válida (PAID)

Usar o script `scripts/test-saga-flow.js` que calcula o HMAC automaticamente:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/pos/tech-challenge-payment-service
node scripts/test-saga-flow.js --scenario webhook-approved --mp-payment-id 98765432
```

A assinatura HMAC-SHA256 é calculada assim:
```js
const { createHmac } = require('crypto');
const ts    = Math.floor(Date.now() / 1000).toString();
const id    = "98765432";           // mp payment id
const reqId = "req-test-001";
const manifest = `id:${id};request-id:${reqId};ts:${ts};`;
const v1 = createHmac('sha256', webhookSecret).update(manifest).digest('hex');
// Header: x-signature: ts=<ts>,v1=<v1>
```

O `webhookSecret` vem do Secrets Manager:
```bash
aws secretsmanager get-secret-value --secret-id payment/mp-webhook-secret \
  --query SecretString --output text | jq -r .webhook_secret
```

---

### Cenário 7 — Webhook tipo não-payment (ignorado)

```bash
curl -s -X POST \
  "https://y3qp355i65.execute-api.us-east-1.amazonaws.com/webhook" \
  -H "Content-Type: application/json" \
  -H "x-signature: ts=<ts>,v1=<hmac_valido>" \
  -H "x-request-id: req-test-ping" \
  -d '{"type":"merchant_order","data":{"id":"999"}}'
# Esperado: 200 {"ignored":true}
```

---

### Monitoramento pós-teste

```bash
# Listar últimas execuções da SAGA
aws stepfunctions list-executions \
  --state-machine-arn "arn:aws:states:us-east-1:008962119864:stateMachine:payment-saga" \
  --max-results 10 \
  --query 'executions[*].{name:name,status:status,start:startDate}' \
  --output table

# Logs da Lambda callback (webhook)
aws logs tail /aws/lambda/payment-callback --follow

# Logs do trigger SQS
aws logs tail /aws/lambda/payment-trigger --follow

# DLQ — verificar mensagens com falha
aws sqs receive-message \
  --queue-url "https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders-dlq" \
  --max-number-of-messages 10 --output json
```

---

### Collection Postman (webhook)

Localização: `postman/collections/payment-service-tests.json`
Ambiente: `postman/environments/production.json`

```bash
# Instalar Postman CLI se não tiver
npm install -g @postman/cli

# Executar collection completa
postman collection run postman/collections/payment-service-tests.json \
  -e postman/environments/production.json
```

> A collection inclui pre-request scripts que calculam o HMAC-SHA256 automaticamente.
> Configure a variável `mp_webhook_secret` no ambiente antes de rodar.

---

## test-webhook

Simula callbacks do Mercado Pago — atalho rápido para o cenário de webhook apenas.

**Ver skill `test-full-flow` para cenários completos.**

**Via script Node.js (recomendado — calcula HMAC automaticamente):**
```bash
node scripts/test-saga-flow.js --scenario webhook-approved --mp-payment-id 98765432
node scripts/test-saga-flow.js --scenario webhook-rejected --mp-payment-id 98765433
```

**Via curl (manual — requer HMAC pré-calculado):**
```bash
SECRET=$(aws secretsmanager get-secret-value --secret-id payment/mp-webhook-secret \
  --query SecretString --output text | jq -r .webhook_secret)
TS=$(date +%s)
ID="98765432"
REQ_ID="req-manual-$(date +%s)"
MANIFEST="id:${ID};request-id:${REQ_ID};ts:${TS};"
HMAC=$(echo -n "$MANIFEST" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

curl -s -w "\n%{http_code}" -X POST \
  "https://y3qp355i65.execute-api.us-east-1.amazonaws.com/webhook" \
  -H "Content-Type: application/json" \
  -H "x-signature: ts=${TS},v1=${HMAC}" \
  -H "x-request-id: ${REQ_ID}" \
  -d "{\"type\":\"payment\",\"data\":{\"id\":\"${ID}\"}}"
```

---

## deploy

Fluxo de deploy e CI/CD.

### Deploy local completo

```bash
cd infra
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
terraform output
```

### Deploy via GitHub Actions

Secrets necessários no repositório:
```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
TF_VAR_mp_access_token       # Token do Mercado Pago
TF_VAR_mp_webhook_secret     # Secret do webhook MP
TF_VAR_app_notification_url  # URL do App para receber o link de pagamento
```

O bucket de state é derivado automaticamente no CI via `aws sts get-caller-identity`.

```bash
# Disparar deploy manual via GitHub CLI
gh workflow run deploy.yml --ref main

# Verificar status
gh run list --workflow=deploy.yml --limit 5
gh run view --log
```

### Pós-deploy obrigatório

Após o primeiro deploy, configurar a URL do webhook no painel do Mercado Pago:
- **Painel MP > Configurações > Notificações > URL de notificações**
- Valor: `terraform output -raw webhook_url`
- Eventos: `Pagamentos`

---

## destroy

Destrói recursos Terraform com segurança.

> **ATENÇÃO:** `recovery_window_in_days = 30` nos Secrets Manager — para destruir e recriar imediatamente, restaurar antes:
> ```bash
> aws secretsmanager restore-secret --secret-id payment/mp-access-token
> aws secretsmanager restore-secret --secret-id payment/mp-webhook-secret
> ```

```bash
# Destruir recurso específico
terraform plan -destroy -target=aws_lambda_function.{nome}
terraform destroy -target=aws_lambda_function.{nome}

# Destruir tudo — revisar o plan antes de confirmar
terraform plan -destroy
terraform destroy
```
