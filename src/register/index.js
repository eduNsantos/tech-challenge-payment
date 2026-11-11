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

function validateCnpj(cnpj) {
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;

  const digit = (base) => {
    const weights = base.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + parseInt(base[i]) * w, 0);
    const rem = sum % 11;
    return rem < 2 ? 0 : 11 - rem;
  };

  const d1 = digit(cnpj.slice(0, 12));
  const d2 = digit(cnpj.slice(0, 12) + d1);
  return d1 === parseInt(cnpj[12]) && d2 === parseInt(cnpj[13]);
}

// customer.cpf aceita CPF (11 dígitos) ou CNPJ (14 dígitos); document_type é opcional e, se enviado, deve bater com o tamanho
function resolveDocumentType(customer) {
  const number = customer.cpf;
  const inferred = /^\d{14}$/.test(number) ? 'CNPJ' : 'CPF';
  const declared = customer.document_type ? String(customer.document_type).toUpperCase() : inferred;

  if (declared !== inferred) return null;

  const valid = inferred === 'CNPJ' ? validateCnpj(number) : validateCpf(number);
  return valid ? inferred : null;
}

exports.handler = async (event) => {
  const { idempotency_key, order_id, amount_cents, currency, description, customer, items, metadata, created_at, callback_url } = event;

  const total = items.reduce((sum, item) => sum + item.quantity * item.unit_price_cents, 0);
  if (total !== amount_cents) {
    const err = new Error(`amount_cents invalido: esperado ${amount_cents}, calculado ${total}`);
    err.name = 'ValidationError';
    throw err;
  }

  const documentType = resolveDocumentType(customer);
  if (!documentType) {
    const err = new Error(`Documento invalido (CPF/CNPJ): ${customer.cpf}`);
    err.name = 'InvalidDocument';
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
      customer: { ...customer, document_type: documentType },
      items,
      metadata: metadata ?? {},
      created_at,
      callback_url: callback_url ?? null,
      status: 'PENDING',
      updated_at: new Date().toISOString(),
      expires_at: expiresAt,
    }),
    ConditionExpression: 'attribute_not_exists(idempotency_key)',
  }));
};

exports.validateCpf = validateCpf;
exports.validateCnpj = validateCnpj;
exports.resolveDocumentType = resolveDocumentType;
