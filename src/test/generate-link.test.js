jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({ SecretString: JSON.stringify({ access_token: 'TEST-token' }) }),
  })),
  GetSecretValueCommand: jest.fn(),
}));

const { handler } = require('../generate-link');

function event(document) {
  return {
    order_id: 'o1',
    amount_cents: 550,
    description: 'Orcamento OS',
    customer: { name: 'Cliente', email: 'c@example.com', cpf: document },
    items: [{ id: 'i1', title: 'Item', quantity: 1, unit_price_cents: 550 }],
  };
}

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'pref-1', init_point: 'https://prod', sandbox_init_point: 'https://sandbox' }),
  });
});

function sentPayer() {
  return JSON.parse(global.fetch.mock.calls[0][1].body).payer;
}

test('envia identification CPF para 11 dígitos', async () => {
  await handler(event('52998224725'));
  expect(sentPayer().identification).toEqual({ type: 'CPF', number: '52998224725' });
});

test('envia identification CNPJ para 14 dígitos', async () => {
  const result = await handler(event('11222333000181'));
  expect(sentPayer().identification).toEqual({ type: 'CNPJ', number: '11222333000181' });
  expect(result.init_point).toBe('https://sandbox');
});
