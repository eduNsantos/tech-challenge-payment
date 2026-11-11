const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { createHash } = require('crypto');

const sqs = new SQSClient({});

function ok(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function err(statusCode, message) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) };
}

exports.handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return err(400, 'Body JSON invalido');
  }

  const { order_id, amount_cents, currency, description, customer, items, metadata, callback_url, notification_url } = body;

  if (!order_id || typeof order_id !== 'string') return err(400, 'order_id obrigatorio');
  if (!amount_cents || typeof amount_cents !== 'number' || amount_cents <= 0) return err(400, 'amount_cents invalido');
  if (!currency || typeof currency !== 'string') return err(400, 'currency obrigatorio');
  if (!customer?.name || !customer?.email || !customer?.cpf) return err(400, 'customer.name, email e cpf obrigatorios');
  if (!Array.isArray(items) || items.length === 0) return err(400, 'items deve ser array nao vazio');

  const created_at = body.created_at ?? new Date().toISOString();

  const idempotency_key = body.idempotency_key
    ?? createHash('sha256').update(`${order_id}|${amount_cents}|${created_at}`).digest('hex');

  const message = {
    idempotency_key,
    order_id,
    amount_cents,
    currency,
    description: description ?? '',
    customer,
    items,
    metadata: metadata ?? {},
    created_at,
    ...(callback_url ? { callback_url } : {}),
    ...(notification_url ? { notification_url } : {}),
  };

  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    MessageBody: JSON.stringify(message),
  }));

  return ok(202, { idempotency_key, order_id, status: 'QUEUED' });
};
