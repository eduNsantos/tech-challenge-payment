jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({ SecretString: JSON.stringify({ access_token: 'TEST-token' }) }),
  })),
  GetSecretValueCommand: jest.fn(),
}));

const mockRecord = jest.fn();
jest.mock('../lib/monitoring', () => ({ recordSagaEvent: (...a) => mockRecord(...a) }));

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

test('registra attempt = 1 na primeira passada', async () => {
  mockRecord.mockReset();
  await handler(event('52998224725'));
  expect(mockRecord).toHaveBeenCalledWith('generate-link', 'LINK_CREATED', expect.objectContaining({ attempt: 1 }));
});

test('registra attempt da nova tentativa diária (link_retry.count + 1) no LINK_ERROR', async () => {
  mockRecord.mockReset();
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
  await expect(handler({ ...event('52998224725'), link_retry: { count: 2 } })).rejects.toThrow('Mercado Pago error 503');
  expect(mockRecord).toHaveBeenCalledWith('generate-link', 'LINK_ERROR', expect.objectContaining({ attempt: 3, httpStatus: 503 }));
});
