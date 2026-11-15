# Monitoramento — New Relic

## Como funciona

As 7 Lambdas usam a **New Relic Lambda layer** (agente Node.js + Lambda Extension).
A extensão envia traces, métricas de invocação, erros e logs **direto para o New Relic** com a license key —
não precisa da integração AWS do New Relic (que não está configurada).

```
Lambda (handler = newrelic-lambda-wrapper.handler)
  └─ agente newrelic  → carrega NEW_RELIC_LAMBDA_HANDLER (ex.: register/index.handler)
  └─ extensão         → lê a license key em Secrets Manager (payment/newrelic-license-key)
                      → envia telemetria + logs para o New Relic
```

O monitoramento é **opcional**: se `newrelic_license_key` ou `newrelic_account_id`
estiver vazio, as Lambdas sobem sem layer e com o handler original. O secret também não é criado.

## Configuração

### No New Relic
1. **Account ID**: menu do usuário → *Administration* → *Access management* → *Accounts*.
2. **License key**: *API keys* → copie uma chave do tipo **INGEST - LICENSE**. Não use a *User key*.
   Use a mesma conta do app no EKS para os traces aparecerem juntos.

### Layer ARN
Não precisa configurar. A layer é pública (publicada pelo New Relic na conta AWS `451483290750`) e a versão
fica fixada no default de `newrelic_layer_arn` em `infra/variables.tf`. Para atualizar, consulte a versão mais recente:

```bash
curl -s "https://us-east-1.layers.newrelic-external.com/get-layers?CompatibleRuntime=nodejs24.x" \
  | jq -r '.Layers[] | select(.LayerName == "NewRelicNodeJS24X") | .LatestMatchingVersion.LayerVersionArn'
```

### GitHub Actions — secrets
| Secret | Variável Terraform |
|---|---|
| `NEW_RELIC_LICENSE_KEY` | `newrelic_license_key` |
| `NEW_RELIC_ACCOUNT_ID` | `newrelic_account_id` |

São os mesmos nomes usados no repo `tech-challenge-kubernetes`.

## Eventos de negócio — `PaymentSaga`

Cada etapa da SAGA registra um custom event via `src/lib/monitoring.js`.
Nenhum dado pessoal (nome, e-mail, CPF/CNPJ) é enviado.

| step | status | Atributos extras |
|---|---|---|
| `orders` | `QUEUED` | `amountCents`, `currency` |
| `trigger` | `STARTED` / `DUPLICATE` | — |
| `register` | `PENDING` | `amountCents`, `currency`, `documentType` |
| `generate-link` | `LINK_CREATED` / `LINK_ERROR` | `attempt` (1 = primeira passada; 2+ = nova tentativa diária), `sandbox` / `httpStatus` |
| `notify-wait` | `WAITING_PAYMENT` | `hasPaymentLink`, `appNotified` |
| `callback` | `PAID` / `REJECTED` / `WEBHOOK_INVALID_SIGNATURE` | `mpPaymentId`, `mpStatus`, `mpStatusDetail`, `paymentMethod`, `durationSeconds` |
| `cancel` | `EXPIRED` | `durationSeconds` |

Todos os eventos têm `orderId` e `idempotencyKey`, exceto `WEBHOOK_INVALID_SIGNATURE`, que só tem `dataId`.

> `FAILED` é gravado pelo próprio Step Functions (sem Lambda). Para acompanhar, use os erros das
> Lambdas `payment-register` e `payment-generate-link` no New Relic.

## Dashboard

`docs/newrelic-dashboard.json` tem o dashboard pronto (conta `8497993`), com duas páginas:

- **Pagamentos**: pedidos, aprovados, taxa de aprovação, valor pago, funil da SAGA, eventos por status,
  tempo até o resultado, falhas/expirações, meio de pagamento e últimos eventos.
- **Lambdas**: invocações, taxa de erro, duração p95, cold starts e erros recentes.

Para importar: New Relic → **Dashboards** → **Import dashboard** → cole o conteúdo do JSON → **Import dashboard**.
Se mudar de conta, troque `8497993` em `accountIds` antes de importar.

> A extensão envia a telemetria de uma invocação na invocação seguinte da mesma instância (ou quando a
> instância é desligada). Com pouco tráfego, os números podem ficar alguns minutos atrasados.

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

-- Pedidos em nova tentativa diária (Mercado Pago falhando)
SELECT latest(attempt), latest(status) FROM PaymentSaga WHERE step = 'generate-link' AND attempt > 1 FACET orderId SINCE 1 week ago

-- Histórico de um pedido
SELECT timestamp, step, status FROM PaymentSaga WHERE orderId = '<order_id>' SINCE 3 days ago
```

**Sugestões de alerta:** `LINK_ERROR > 0` em 5 min; `WEBHOOK_INVALID_SIGNATURE > 5` em 5 min;
taxa de erro de qualquer Lambda `payment-*` acima de 5%.

## Fora do escopo (por enquanto)

- Métricas CloudWatch de SQS / DynamoDB / Step Functions / API Gateway: exigem a integração AWS do New Relic
  (role de polling ou Metric Streams via Firehose). Ainda não foi configurada.
- Trace distribuído ponta a ponta (app → SQS → Step Functions): exige propagar `traceparent` na mensagem.
