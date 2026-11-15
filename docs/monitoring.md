# Monitoramento — New Relic

## Como funciona

As 7 Lambdas usam a **New Relic Lambda layer** (agente Node.js + Lambda Extension).
A extensão envia traces, métricas de invocação, erros e logs **direto para o New Relic** com a license key —
não precisa de IAM role nem da integração AWS do New Relic (que exige `iam:CreateRole`, bloqueado pelo SCP do Academy).

```
Lambda (handler = newrelic-lambda-wrapper.handler)
  └─ agente newrelic  → carrega NEW_RELIC_LAMBDA_HANDLER (ex.: register/index.handler)
  └─ extensão         → lê a license key em Secrets Manager (payment/newrelic-license-key)
                      → envia telemetria + logs para o New Relic
```

O monitoramento é **opcional**: se `newrelic_license_key`, `newrelic_account_id` ou `newrelic_layer_arn`
estiver vazio, as Lambdas sobem sem layer e com o handler original. O secret também não é criado.

## Configuração

### No New Relic
1. **Account ID**: menu do usuário → *Administration* → *Access management* → *Accounts*.
2. **License key**: *API keys* → copie uma chave do tipo **INGEST - LICENSE**. Não use a *User key*.
   Use a mesma conta do app no EKS para os traces aparecerem juntos.

### Layer ARN
Escolha a versão mais recente da layer `NewRelicNodeJS24X` em us-east-1:

- https://layers.newrelic-external.com/ (selecione a região `us-east-1`), ou
- `aws lambda list-layer-versions --region us-east-1 --layer-name arn:aws:lambda:us-east-1:451483290750:layer:NewRelicNodeJS24X`

Se ainda não houver layer para Node 24, use a `NewRelicNodeJS22X` e troque o `runtime` das Lambdas para `nodejs22.x`.

### GitHub Actions — secrets
| Secret | Variável Terraform |
|---|---|
| `NEW_RELIC_LICENSE_KEY` | `newrelic_license_key` |
| `NEW_RELIC_ACCOUNT_ID` | `newrelic_account_id` |
| `NEW_RELIC_LAYER_ARN` | `newrelic_layer_arn` |

## Eventos de negócio — `PaymentSaga`

Cada etapa da SAGA registra um custom event via `src/lib/monitoring.js`.
Nenhum dado pessoal (nome, e-mail, CPF/CNPJ) é enviado.

| step | status | Atributos extras |
|---|---|---|
| `orders` | `QUEUED` | `amountCents`, `currency` |
| `trigger` | `STARTED` / `DUPLICATE` | — |
| `register` | `PENDING` | `amountCents`, `currency`, `documentType` |
| `generate-link` | `LINK_CREATED` / `LINK_ERROR` | `sandbox` / `httpStatus` |
| `notify-wait` | `WAITING_PAYMENT` | `hasPaymentLink`, `appNotified` |
| `callback` | `PAID` / `REJECTED` / `WEBHOOK_INVALID_SIGNATURE` | `mpPaymentId`, `mpStatus`, `mpStatusDetail`, `paymentMethod`, `durationSeconds` |
| `cancel` | `EXPIRED` | `durationSeconds` |

Todos os eventos têm `orderId` e `idempotencyKey`, exceto `WEBHOOK_INVALID_SIGNATURE`, que só tem `dataId`.

> `FAILED` é gravado pelo próprio Step Functions (sem Lambda). Para acompanhar, use os erros das
> Lambdas `payment-register` e `payment-generate-link` no New Relic e o alarme da DLQ → SNS.

## Consultas NRQL úteis

```sql
-- Funil por status
SELECT count(*) FROM PaymentSaga FACET status SINCE 1 day ago

-- Taxa de aprovação
SELECT percentage(count(*), WHERE status = 'PAID') FROM PaymentSaga
WHERE status IN ('PAID', 'REJECTED', 'EXPIRED') SINCE 1 day ago

-- Tempo até pagamento (p50/p95)
SELECT percentile(durationSeconds, 50, 95) FROM PaymentSaga WHERE status = 'PAID' SINCE 1 week ago

-- Valor pago (R$)
SELECT sum(amountCents) / 100 FROM PaymentSaga WHERE status = 'PAID' TIMESERIES SINCE 1 day ago

-- Falhas ao gerar link / webhooks com assinatura inválida
SELECT count(*) FROM PaymentSaga WHERE status IN ('LINK_ERROR', 'WEBHOOK_INVALID_SIGNATURE')
FACET status TIMESERIES SINCE 1 day ago

-- Histórico de um pedido
SELECT timestamp, step, status FROM PaymentSaga WHERE orderId = '<order_id>' SINCE 3 days ago
```

**Sugestões de alerta:** `LINK_ERROR > 0` em 5 min; `WEBHOOK_INVALID_SIGNATURE > 5` em 5 min;
taxa de erro de qualquer Lambda `payment-*` acima de 5%.

## Fora do escopo (por enquanto)

- Métricas CloudWatch de SQS / DynamoDB / Step Functions / API Gateway: a integração por polling exige IAM role;
  Metric Streams via Firehose depende de a `LabRole` confiar em `streams.metrics.cloudwatch.amazonaws.com`. Ainda não foi testado.
- Trace distribuído ponta a ponta (app → SQS → Step Functions): exige propagar `traceparent` na mensagem.
