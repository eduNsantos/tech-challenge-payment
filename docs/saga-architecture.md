# SAGA Architecture — payment-service

## Visão geral

O payment-service implementa o padrão **SAGA com Orquestração** usando AWS Step Functions como orquestrador central. A escolha de orquestração (em vez de coreografia) é necessária porque o gateway de pagamento externo (Mercado Pago) não emite eventos SAGA — exige um coordenador central que conheça o estado de cada execução.

---

## Componentes

| Componente | Tecnologia | Papel |
|---|---|---|
| Fila de entrada | SQS Standard | Recebe ordens do App/EKS |
| Lambda Trigger | Node.js 24.x | Polls SQS, inicia execução no Step Functions (máx. 5 simultâneas) |
| Orquestrador | AWS Step Functions | Executa os 5 passos da SAGA |
| Estado | DynamoDB | Log de estado e transições de cada saga |
| Dead-letter | SQS DLQ | Recebe sagas que falharam definitivamente |
| Notificação | SNS | Notifica serviço externo quando mensagem vai para DLQ |
| Webhook | API Gateway v2 + Lambda Callback | Recebe callbacks do Mercado Pago |

---

## Os 5 passos da SAGA

```
┌─────────────────────────────────────────────────────────┐
│                    AWS Step Functions                   │
│                                                         │
│  ① REGISTRAR ──► ② GERAR LINK ──► ③ NOTIFICAR APP      │
│                       │                    │            │
│                    [falha 3×]              ▼            │
│                       │           ④ AGUARDAR CALLBACK   │
│                       │            (WaitForTaskToken)   │
│                       │               │        │        │
│                       │           [aprovado] [timeout]  │
│                       │               │        │        │
│                       │             PAID   ⑤ CANCELAR  │
│                       ▼                        │        │
│                      DLQ ◄─────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### Step ① — REGISTRAR

- Valida o payload (soma dos itens, CPF, `amount_cents`)
- Grava item no DynamoDB com `status = PENDING`
- Usa `idempotency_key` como partition key — impede processar a mesma ordem duas vezes
- O `idempotency_key` também é o `name` da execução no Step Functions (rejeição nativa de duplicatas)

### Step ② — GERAR LINK

- Chama a API do Mercado Pago para criar a preferência de pagamento
- Retry: 3 tentativas com backoff exponencial, timeout de 3s por tentativa
- Envia `order_id` como `external_reference` para conciliação no callback
- **Compensação:** 3 falhas consecutivas → aborta a saga → mensagem vai para DLQ

### Step ③ — NOTIFICAR APP

- Envia o link de pagamento gerado para a aplicação de origem
- Atualiza DynamoDB: `status = WAITING_PAYMENT`

### Step ④ — AGUARDAR CALLBACK

- Pausa a execução via `WaitForTaskToken`
- **Heartbeat:** 30 minutos
- **Timeout:** 48 horas
- Resolvido pelo webhook do Mercado Pago (ver seção [Fluxo de Callback](#fluxo-de-callback))
  - Pagamento aprovado → `sendTaskSuccess` → `status = PAID`
  - Pagamento rejeitado → `sendTaskFailure` → `status = REJECTED`
  - Timeout de 48h → Step ⑤

### Step ⑤ — CANCELAR (compensação)

- Cancela o link de pagamento no Mercado Pago
- Atualiza DynamoDB: `status = EXPIRED`
- Envia mensagem para DLQ → SNS notifica serviço externo

---

## Fluxo de Callback

Entrada independente do fluxo principal da SAGA:

```
Mercado Pago
    │
    │  POST /webhook
    ▼
API Gateway v2
    │
    ▼
Lambda Callback
    │
    ├── 1. Valida x-signature (HMAC-SHA256 com secret do Secrets Manager)
    ├── 2. Busca detalhes do pagamento na API do Mercado Pago via data.id
    ├── 3. Atualiza DynamoDB com status final
    └── 4. sendTaskSuccess / sendTaskFailure → resolve WaitForTaskToken (Step ④)
```

### Validação do x-signature

O Mercado Pago assina cada webhook com HMAC-SHA256. Formato do header:

```
x-signature: ts=<timestamp_unix>,v1=<hmac_hex>
```

String assinada: `id:<notification_id>;request-id:<x-request-id>;ts:<timestamp>;`

O secret é armazenado no AWS Secrets Manager em `payment/mp-webhook-secret`.

---

## Idempotência

O `idempotency_key` é o mecanismo central de idempotência e serve três propósitos:

| Onde | Como é usado |
|---|---|
| DynamoDB (Step ①) | Partition key — conditional write impede sobrescrever saga existente |
| Step Functions | `name` da execução — SF rejeita execuções com nome duplicado nativamente |
| Mercado Pago | Campo `external_reference` — identifica o pedido no gateway e concilia o callback |

### Geração (responsabilidade do produtor)

```
idempotency_key = SHA-256( order_id + "|" + amount_cents + "|" + created_at )
```

O hash é gerado pelo serviço de origem (App/EKS) antes de enfileirar no SQS.

---

## Fluxos de falha e DLQ

### DLQ Alimentador 1 — falha no gateway

```
Step ② esgota 3 tentativas → aborta saga → DynamoDB: FAILED → DLQ → SNS
```

### DLQ Alimentador 2 — timeout de 48h

```
Step ④ timeout → Step ⑤ (cancela gateway) → DynamoDB: EXPIRED → DLQ → SNS
```

Ambos os casos disparam o SNS para notificação ao serviço externo.

---

## Diagrama de estados do DynamoDB

```
PENDING
  │
  ├──► WAITING_PAYMENT  (Step ③ concluído, aguardando callback)
  │         │
  │         ├──► PAID      (callback: payment approved)
  │         ├──► REJECTED  (callback: payment rejected)
  │         └──► EXPIRED   (timeout 48h → Step ⑤ executado)
  │
  └──► FAILED            (Step ② esgotou tentativas)
```

---

## Infraestrutura AWS

| Recurso | Identificador |
|---|---|
| Região | `us-east-1` |
| Account | `477478162709` |
| Backend Terraform | S3 `techchallenge-tfstate-477478162709` / key `payment-service/terraform.tfstate` |
| VPC | `aws_vpc "main"` (compartilhada com EKS) |
| Subnets | `sub_a` (us-east-1a), `sub_b` (us-east-1b) |
| Runtime Lambda | Node.js 24.x |
| API Gateway | v2 HTTP API (`protocol_type = "HTTP"`) |
| Secrets Manager | `payment/mp-webhook-secret`, `payment/mp-access-token` |

---

## Schema da mensagem SQS

Ver [`../bruno/docs/sqs-message-schema.md`](../bruno/docs/sqs-message-schema.md) para o contrato completo de entrada da fila `payment-orders`.
