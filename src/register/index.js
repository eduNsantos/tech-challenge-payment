const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');

const dynamo = new DynamoDBClient({});

function validateCpf(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i);
  let rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  if (rem !== parseInt(cpf[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i);
  rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  return rem === parseInt(cpf[10]);
}

exports.handler = async (event) => {
  const { idempotency_key, order_id, amount_cents, currency, description, customer, items, metadata, created_at } = event;

  const total = items.reduce((sum, item) => sum + item.quantity * item.unit_price_cents, 0);
  if (total !== amount_cents) {
    const err = new Error(`amount_cents invalido: esperado ${amount_cents}, calculado ${total}`);
    err.name = 'ValidationError';
    throw err;
  }

  if (!validateCpf(customer.cpf)) {
    const err = new Error(`CPF invalido: ${customer.cpf}`);
    err.name = 'InvalidCPF';
    throw err;
  }

  // TTL: 60 dias apos criacao
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60;

  await dynamo.send(new PutItemCommand({
    TableName: process.env.DYNAMODB_TABLE,
    Item: marshall({
      idempotency_key,
      order_id,
      amount_cents,
      currency,
      description,
      customer,
      items,
      metadata: metadata ?? {},
      created_at,
      status: 'PENDING',
      updated_at: new Date().toISOString(),
      expires_at: expiresAt,
    }),
    ConditionExpression: 'attribute_not_exists(idempotency_key)',
  }));
};
