const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } = require('@aws-sdk/client-sfn');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { createHmac } = require('crypto');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamo = new DynamoDBClient({});
const sfn = new SFNClient({});
const sm = new SecretsManagerClient({});
let cachedWebhookSecret, cachedMpToken;

async function getWebhookSecret() {
  if (cachedWebhookSecret) return cachedWebhookSecret;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.MP_WEBHOOK_SECRET_ID }));
  cachedWebhookSecret = JSON.parse(res.SecretString).webhook_secret;
  return cachedWebhookSecret;
}

async function getMpToken() {
  if (cachedMpToken) return cachedMpToken;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.MP_ACCESS_TOKEN_SECRET_ID }));
  cachedMpToken = JSON.parse(res.SecretString).access_token;
  return cachedMpToken;
}

function validateSignature(headers, body, secret) {
  const xSignature = headers['x-signature'];
  const xRequestId = headers['x-request-id'];
  if (!xSignature) return false;

  const parts = Object.fromEntries(xSignature.split(',').map(p => p.split('=')));
  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (!ts || !v1) return false;

  const id = JSON.parse(body)?.id ?? '';
  const manifest = `id:${id};request-id:${xRequestId ?? ''};ts:${ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');

  return expected === v1;
}

function ok(body = {}) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function err(status, message) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) };
}

exports.handler = async (event) => {
  const rawBody = event.body ?? '{}';
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );

  // Valida assinatura HMAC-SHA256 do Mercado Pago
  const secret = await getWebhookSecret();
  if (!validateSignature(headers, rawBody, secret)) {
    console.warn('Webhook com assinatura invalida rejeitado');
    return err(401, 'Assinatura invalida');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return err(400, 'Body invalido');
  }

  // O MP envia apenas o ID do pagamento; buscamos os detalhes na API
  if (payload.type !== 'payment') {
    return ok({ ignored: true });
  }

  const mpPaymentId = payload.data?.id;
  if (!mpPaymentId) return err(400, 'data.id ausente');

  const token = await getMpToken();
  const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${mpPaymentId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!mpRes.ok) {
    console.error(`Erro ao buscar pagamento ${mpPaymentId} no Mercado Pago`);
    return err(502, 'Erro ao consultar gateway');
  }

  const payment = await mpRes.json();
  const orderId = payment.external_reference;
  const status = payment.status;

  // Busca o registro no DynamoDB pelo order_id (requer GSI ou scan — ajustar conforme necessidade)
  // Alternativa simplificada: usa external_reference como idempotency_key prefix para lookup
  const { Items } = await dynamo.send({
    TableName: process.env.DYNAMODB_TABLE,
    IndexName: 'order_id-index',
    KeyConditionExpression: 'order_id = :oid',
    ExpressionAttributeValues: marshall({ ':oid': orderId }),
  }).catch(() => ({ Items: [] }));

  const record = Items?.[0] ? unmarshall(Items[0]) : null;
  if (!record?.task_token) {
    console.warn(`task_token nao encontrado para order_id ${orderId}`);
    return ok({ ignored: true });
  }

  const { task_token: taskToken, idempotency_key } = record;
  const newStatus = status === 'approved' ? 'PAID' : 'REJECTED';

  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.DYNAMODB_TABLE,
    Key: marshall({ idempotency_key }),
    UpdateExpression: 'SET #s = :s, mp_payment_id = :pid, updated_at = :u',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({
      ':s': newStatus,
      ':pid': String(mpPaymentId),
      ':u': new Date().toISOString(),
    }),
  }));

  if (status === 'approved') {
    await sfn.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ mp_payment_id: mpPaymentId, status }),
    }));
  } else {
    await sfn.send(new SendTaskFailureCommand({
      taskToken,
      error: 'PaymentRejected',
      cause: `status=${status}, detail=${payment.status_detail}`,
    }));
  }

  return ok({ processed: true, status: newStatus });
};
