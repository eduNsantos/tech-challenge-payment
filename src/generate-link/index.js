const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { recordSagaEvent } = require('../lib/monitoring');

const sm = new SecretsManagerClient({});
let cachedToken;

async function getMpToken() {
  if (cachedToken) return cachedToken;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.MP_ACCESS_TOKEN_SECRET_ID }));
  cachedToken = JSON.parse(res.SecretString).access_token;
  return cachedToken;
}

function backUrlsConfig() {
  const back_urls = Object.fromEntries(
    [['success', process.env.BACK_URL_SUCCESS], ['pending', process.env.BACK_URL_PENDING], ['failure', process.env.BACK_URL_FAILURE]]
      .filter(([, url]) => url)
  );
  if (Object.keys(back_urls).length === 0) return {};
  // MP rejeita auto_return sem back_urls.success definido
  return { back_urls, ...(back_urls.success && { auto_return: 'approved' }) };
}

// customer.cpf carrega CPF (11 dígitos) ou CNPJ (14 dígitos) — já validado no Step ①
function documentType(number) {
  return String(number).length === 14 ? 'CNPJ' : 'CPF';
}

exports.handler = async (event) => {
  const { idempotency_key, order_id, amount_cents, description, customer, items } = event;
  // 1 na primeira passada; +1 a cada nova tentativa diária do Step Functions (link_retry.count)
  const attempt = (event.link_retry?.count ?? 0) + 1;
  const token = await getMpToken();

  const body = {
    external_reference: order_id,
    statement_descriptor: description.slice(0, 16),
    notification_url: process.env.WEBHOOK_URL,
    ...backUrlsConfig(),
    payer: {
      name: customer.name,
      email: customer.email,
      identification: { type: documentType(customer.cpf), number: customer.cpf },
      ...(customer.phone && {
        phone: {
          area_code: customer.phone.slice(3, 5),
          number: customer.phone.slice(5),
        },
      }),
    },
    items: items.map(item => ({
      id: item.id,
      title: item.title,
      quantity: item.quantity,
      unit_price: item.unit_price_cents / 100,
      currency_id: 'BRL',
    })),
  };

  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    recordSagaEvent('generate-link', 'LINK_ERROR', { orderId: order_id, idempotencyKey: idempotency_key, httpStatus: response.status, attempt });
    const err = new Error(`Mercado Pago error ${response.status}: ${JSON.stringify(error)}`);
    err.name = 'MercadoPagoError';
    throw err;
  }

  const preference = await response.json();
  const isSandbox = token.startsWith('TEST-');

  recordSagaEvent('generate-link', 'LINK_CREATED', {
    orderId: order_id, idempotencyKey: idempotency_key, amountCents: amount_cents, sandbox: isSandbox, attempt,
  });

  return {
    preference_id: preference.id,
    init_point: isSandbox ? preference.sandbox_init_point : preference.init_point,
  };
};
