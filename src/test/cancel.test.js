const mockDynamoSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  GetItemCommand: jest.fn((input) => ({ type: 'get', input })),
  UpdateItemCommand: jest.fn((input) => ({ type: 'update', input })),
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: jest.fn().mockResolvedValue({ SecretString: JSON.stringify({ access_token: 'TEST-token' }) }),
  })),
  GetSecretValueCommand: jest.fn(),
}));

const { marshall } = require('@aws-sdk/util-dynamodb');
const { handler } = require('../cancel');

function record(overrides = {}) {
  return {
    idempotency_key: 'k1',
    order_id: 'o1',
    amount_cents: 550,
    currency: 'BRL',
    description: 'Orcamento OS',
    customer: { name: 'Cliente', email: 'c@example.com', cpf: '52998224725' },
    items: [{ id: 'i1', title: 'Item', quantity: 1, unit_price_cents: 550 }],
    payment_link: 'https://mp/checkout',
    created_at: '2026-11-11T10:00:00Z',
    status: 'WAITING_PAYMENT',
    ...overrides,
  };
}

beforeEach(() => {
  mockDynamoSend.mockReset();
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
});

function mockRecord(rec) {
  mockDynamoSend.mockImplementation(async (cmd) => (cmd.type === 'get' ? { Item: marshall(rec) } : {}));
}

test('marca EXPIRED e envia callback com status EXPIRED', async () => {
  mockRecord(record({ callback_url: 'https://app/api/payment/callback/tok' }));

  await handler({ idempotency_key: 'k1' });

  const update = mockDynamoSend.mock.calls.find(([c]) => c.type === 'update')[0];
  expect(update.input.ExpressionAttributeValues[':s'].S).toBe('EXPIRED');

  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = global.fetch.mock.calls[0];
  expect(url).toBe('https://app/api/payment/callback/tok');
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ order_id: 'o1', status: 'EXPIRED', payment_link: 'https://mp/checkout' });
});

test('não chama callback quando callback_url ausente', async () => {
  mockRecord(record());

  await handler({ idempotency_key: 'k1' });

  expect(global.fetch).not.toHaveBeenCalled();
});

test('falha no callback não interrompe a compensação', async () => {
  mockRecord(record({ callback_url: 'https://app/cb' }));
  global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  await expect(handler({ idempotency_key: 'k1' })).resolves.toBeUndefined();
});
