const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
  UpdateItemCommand: jest.fn((input) => ({ input })),
}));

const { handler } = require('../notify-wait');

function event(input = {}) {
  return {
    taskToken: 'token-1',
    input: {
      idempotency_key: 'k1',
      order_id: 'o1',
      payment_link: { Payload: { init_point: 'https://mp/checkout' } },
      ...input,
    },
  };
}

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue({});
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  delete process.env.APP_NOTIFICATION_URL;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

test('notifica a notification_url enviada na mensagem', async () => {
  process.env.APP_NOTIFICATION_URL = 'https://fallback/notify';

  await handler(event({ notification_url: 'https://app/api/payment/notification' }));

  const [url, init] = global.fetch.mock.calls[0];
  expect(url).toBe('https://app/api/payment/notification');
  expect(JSON.parse(init.body)).toEqual({ order_id: 'o1', payment_link: 'https://mp/checkout', status: 'WAITING_PAYMENT' });
  expect(mockSend.mock.calls[0][0].input.ExpressionAttributeValues[':s'].S).toBe('WAITING_PAYMENT');
});

test('usa APP_NOTIFICATION_URL como fallback', async () => {
  process.env.APP_NOTIFICATION_URL = 'https://fallback/notify';

  await handler(event());

  expect(global.fetch.mock.calls[0][0]).toBe('https://fallback/notify');
});

test('sem URL nenhuma apenas registra aviso', async () => {
  await handler(event());

  expect(global.fetch).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalled();
});

test('falha de rede na notificação não derruba a SAGA', async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

  await expect(handler(event({ notification_url: 'https://app/n' }))).resolves.toBeUndefined();
});
