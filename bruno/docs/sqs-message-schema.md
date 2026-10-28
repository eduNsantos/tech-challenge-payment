# payment-service — SQS Message Schema

**Fila:** `payment-orders` · **AsyncAPI v1.0**

Payload enviado pelo App/EKS via SQS para disparar uma nova cobrança no payment-service.

---

## Raiz da mensagem

| Campo | Tipo | Req | Descrição |
|---|---|---|---|
| `idempotency_key` | string | ✅ | SHA-256 hex (64 chars) gerado pelo produtor. Partition key no DynamoDB e `name` da execução no Step Functions. Fórmula: `sha256(order_id + "\|" + amount_cents + "\|" + created_at)` |
| `order_id` | string (uuid v4) | ✅ | UUID do pedido no sistema de origem. Enviado ao Mercado Pago como `external_reference`. |
| `created_at` | string (ISO 8601 UTC) | ✅ | Timestamp de criação. Deve terminar em `Z`. Compõe o `idempotency_key`. |
| `amount_cents` | integer (≥ 1) | ✅ | Valor total em centavos. Ex: R$ 150,00 → `15000`. |
| `currency` | string (enum) | ✅ | Código da moeda. Valores aceitos: `"BRL"`. |
| `description` | string (≤ 256 chars) | ✅ | Descrição do pedido exibida no checkout do gateway. |

---

## customer (object, required)

| Campo | Tipo | Req | Descrição |
|---|---|---|---|
| `name` | string (≤ 256 chars) | ✅ | Nome completo do pagador. |
| `email` | string (email) | ✅ | E-mail do pagador. Formato RFC 5322. |
| `cpf` | string | ✅ | CPF sem formatação, 11 dígitos. Padrão: `^\d{11}$`. Ex: `"12345678901"`. |
| `phone` | string | ⬜ | Telefone E.164. Padrão: `^\+55\d{10,11}$`. Ex: `"+5511999999999"`. |

---

## items (array, required, mínimo 1 item)

| Campo | Tipo | Req | Descrição |
|---|---|---|---|
| `id` | string | ✅ | ID do produto no sistema de origem. |
| `title` | string (≤ 256 chars) | ✅ | Nome do produto exibido no checkout. |
| `quantity` | integer (≥ 1) | ✅ | Quantidade do item. |
| `unit_price_cents` | integer (≥ 1) | ✅ | Preço unitário em centavos. |

---

## metadata (object, optional)

| Campo | Tipo | Req | Descrição |
|---|---|---|---|
| `source_service` | string | ⬜ | Nome do serviço de origem. Ex: `"pos-application"`. |
| `operator_id` | string (uuid) | ⬜ | UUID do operador que registrou o pedido. |
| `store_id` | string (uuid) | ⬜ | UUID da loja de origem. |

---

## Exemplo completo

```json
{
  "idempotency_key": "a3f4b2c1d8e7f9004a5b6c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3",
  "order_id":        "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "created_at":      "2026-10-28T14:32:00Z",
  "amount_cents":    15000,
  "currency":        "BRL",
  "description":     "Pedido #4872 — POS Tech Challenge",

  "customer": {
    "name":  "João da Silva",
    "email": "joao.silva@email.com",
    "cpf":   "12345678901",
    "phone": "+5511999999999"
  },

  "items": [
    {
      "id":               "PROD-001",
      "title":            "Lanche Artesanal",
      "quantity":         2,
      "unit_price_cents": 5000
    },
    {
      "id":               "PROD-042",
      "title":            "Suco Natural 500ml",
      "quantity":         1,
      "unit_price_cents": 5000
    }
  ],

  "metadata": {
    "source_service": "pos-application",
    "operator_id":    "3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f",
    "store_id":       "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
  }
}
```

> **Verificação:** `items[0].quantity × unit_price_cents` = 2 × 5000 = 10000
> `items[1].quantity × unit_price_cents` = 1 × 5000 = 5000
> **Total = 15000 ✅ amount_cents**

---

## Regras de validação

| # | Regra | Consequência da violação |
|---|---|---|
| 1 | `sum(item.quantity × item.unit_price_cents) == amount_cents` | Step ① aborta a saga e envia para DLQ |
| 2 | `idempotency_key = sha256(order_id + "\|" + amount_cents + "\|" + created_at)` | Step Functions rejeita execução duplicada |
| 3 | CPF com dígitos verificadores válidos (algoritmo Receita Federal) | Step ① encerra com `status = INVALID_CPF` |
| 4 | `amount_cents` deve ser inteiro positivo (não float) | Rejeição imediata no Step ① |
| 5 | `created_at` deve terminar em `Z` (UTC) | Divergência no `idempotency_key` entre serviços |
| 6 | SQS Standard: at-least-once delivery — o `idempotency_key` é a única defesa contra duplicatas | — |
| 7 | `items` não pode ser array vazio | Mercado Pago rejeita preferência sem itens; validado no Step ① |

---

## Contexto SAGA

Esta mensagem SQS dispara uma execução da SAGA com 5 passos no AWS Step Functions:

```
① REGISTRAR   → grava DynamoDB (PENDING), usa idempotency_key como PK
② GERAR LINK  → chama Mercado Pago, retry 3× backoff, timeout 3s
③ NOTIFICAR   → envia link ao App, DynamoDB → WAITING_PAYMENT
④ AGUARDAR    → WaitForTaskToken, heartbeat 30min, timeout 48h
⑤ CANCELAR    → (compensação) cancela gateway, DynamoDB → EXPIRED, → DLQ
```

O `order_id` é enviado ao Mercado Pago como `external_reference` para conciliar o callback no webhook `POST /webhook`.
