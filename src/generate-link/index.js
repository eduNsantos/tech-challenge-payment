const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const sm = new SecretsManagerClient({});
let cachedToken;

async function getMpToken() {
  if (cachedToken) return cachedToken;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.MP_ACCESS_TOKEN_SECRET_ID }));
  cachedToken = JSON.parse(res.SecretString).access_token;
  return cachedToken;
}

exports.handler = async (event) => {
  const { order_id, amount_cents, description, customer, items } = event;
  const token = await getMpToken();

  const body = {
    external_reference: order_id,
    statement_descriptor: description.slice(0, 16),
    notification_url: process.env.WEBHOOK_URL,
    payer: {
      name: customer.name,
      email: customer.email,
      identification: { type: 'CPF', number: customer.cpf },
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
    const err = new Error(`Mercado Pago error ${response.status}: ${JSON.stringify(error)}`);
    err.name = 'MercadoPagoError';
    throw err;
  }

  const preference = await response.json();

  return {
    Payload: {
      preference_id: preference.id,
      init_point: preference.init_point,
    },
  };
};
