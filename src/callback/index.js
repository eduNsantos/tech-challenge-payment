const { DynamoDBClient, GetItemCommand, UpdateItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } = require('@aws-sdk/client-sfn');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { createHmac, timingSafeEqual } = require('crypto');
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

function resolveDataId(query, body) {
  // Doc MP: data.id vem da query string da notification_url; body é fallback
  let id = query['data.id'];
  if (!id) {
    try { id = JSON.parse(body)?.data?.id; } catch { id = undefined; }
  }
  if (id === undefined || id === null || id === '') return null;
  const str = String(id);
  return /[a-z]/i.test(str) ? str.toLowerCase() : str;
}

function validateSignature(headers, query, body, secret) {
  const xSignature = headers['x-signature'];
  const xRequestId = headers['x-request-id'];
  if (!xSignature) return false;

  const parts = Object.fromEntries(
    xSignature.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (!ts || !v1) return false;

  // Template: id:[data.id];request-id:[x-request-id];ts:[ts]; — partes ausentes são omitidas
  const dataId = resolveDataId(query, body);
  const manifest =
    (dataId ? `id:${dataId};` : '') +
    (xRequestId ? `request-id:${xRequestId};` : '') +
    `ts:${ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
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

  const query = event.queryStringParameters ?? {};

  // Valida assinatura HMAC-SHA256 do Mercado Pago
  const secret = await getWebhookSecret();
  const signatureValid = validateSignature(headers, query, rawBody, secret);
  console.info(JSON.stringify({
    event: 'mp_webhook_received',
    request_id: headers['x-request-id'] ?? null,
    type: query.type ?? query.topic ?? null,
    data_id: resolveDataId(query, rawBody),
    signature_valid: signatureValid,
  }));
  if (!signatureValid) {
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

  const mpPaymentId = payload.data?.id ?? query['data.id'];
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

  // PIX/boleto aguardando confirmação bancária — mantém WaitForTaskToken ativo
  if (status === 'pending') {
    console.info(`Pagamento ${mpPaymentId} em status pending para order ${orderId} — aguardando`);
    return ok({ processed: false, status: 'WAITING_PAYMENT' });
  }

  const { Items } = await dynamo.send(new QueryCommand({
    TableName: process.env.DYNAMODB_TABLE,
    IndexName: 'order_id-index',
    KeyConditionExpression: 'order_id = :oid',
    ExpressionAttributeValues: marshall({ ':oid': orderId }),
  })).catch(() => ({ Items: [] }));

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

  if (record.callback_url) {
    const callbackPayload = {
      order_id:         record.order_id,
      idempotency_key:  record.idempotency_key,
      status:           newStatus,
      amount_cents:     record.amount_cents,
      currency:         record.currency,
      description:      record.description,
      customer:         record.customer,
      items:            record.items,
      payment_link:     record.payment_link ?? null,
      mp_payment_id:    String(mpPaymentId),
      created_at:       record.created_at,
      updated_at:       new Date().toISOString(),
      metadata:         record.metadata ?? {},
    };

    try {
      const res = await fetch(record.callback_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(callbackPayload),
      });
      if (!res.ok) {
        console.warn(`callback_url retornou ${res.status} para order ${orderId}`);
      }
    } catch (err) {
      console.warn(`Falha ao notificar callback_url para order ${orderId}: ${err.message}`);
    }
  }

  return ok({ processed: true, status: newStatus });
};
