const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamo = new DynamoDBClient({});
const sm = new SecretsManagerClient({});
let cachedToken;

async function getMpToken() {
  if (cachedToken) return cachedToken;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.MP_ACCESS_TOKEN_SECRET_ID }));
  cachedToken = JSON.parse(res.SecretString).access_token;
  return cachedToken;
}

exports.handler = async (event) => {
  const { idempotency_key } = event;

  const { Item } = await dynamo.send(new GetItemCommand({
    TableName: process.env.DYNAMODB_TABLE,
    Key: marshall({ idempotency_key }),
  }));

  const record = Item ? unmarshall(Item) : null;

  if (record?.payment_link) {
    try {
      const token = await getMpToken();
      // Mercado Pago não expõe endpoint de cancelamento de preferências, apenas de pagamentos.
      // Registra o evento de expiração para conciliação posterior.
      console.info(`Preferencia expirada para order ${record.order_id} — link: ${record.payment_link}`);

      // Se houver um payment_id associado (capturado via webhook parcial), cancela o pagamento
      if (record.mp_payment_id) {
        await fetch(`https://api.mercadopago.com/v1/payments/${record.mp_payment_id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: 'cancelled' }),
        });
      }
    } catch (err) {
      console.warn(`Erro ao cancelar no gateway (best-effort): ${err.message}`);
    }
  }

  const updatedAt = new Date().toISOString();

  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.DYNAMODB_TABLE,
    Key: marshall({ idempotency_key }),
    UpdateExpression: 'SET #s = :s, updated_at = :u',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({
      ':s': 'EXPIRED',
      ':u': updatedAt,
    }),
  }));

  // Informa o sistema de origem que a cobrança expirou (best-effort, mesmo payload do callback de PAID/REJECTED)
  if (record?.callback_url) {
    const callbackPayload = {
      order_id:        record.order_id,
      idempotency_key: record.idempotency_key,
      status:          'EXPIRED',
      amount_cents:    record.amount_cents,
      currency:        record.currency,
      description:     record.description,
      customer:        record.customer,
      items:           record.items,
      payment_link:    record.payment_link ?? null,
      mp_payment_id:   record.mp_payment_id ?? null,
      created_at:      record.created_at,
      updated_at:      updatedAt,
      metadata:        record.metadata ?? {},
    };

    try {
      const res = await fetch(record.callback_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(callbackPayload),
      });
      if (!res.ok) {
        console.warn(`callback_url retornou ${res.status} para order ${record.order_id}`);
      }
    } catch (err) {
      console.warn(`Falha ao notificar callback_url para order ${record.order_id}: ${err.message}`);
    }
  }
};
