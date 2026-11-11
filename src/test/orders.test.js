const mockSend = jest.fn();

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSend })),
  SendMessageCommand: jest.fn((input) => ({ input })),
}));

const { handler } = require('../orders');

const body = {
  order_id: 'o1',
  amount_cents: 550,
  currency: 'BRL',
  customer: { name: 'Cliente', email: 'c@example.com', cpf: '52998224725' },
  items: [{ id: 'i1', title: 'Item', quantity: 1, unit_price_cents: 550 }],
  created_at: '2026-11-11T10:00:00Z',
};

beforeEach(() => mockSend.mockReset().mockResolvedValue({}));

function sentMessage() {
  return JSON.parse(mockSend.mock.calls[0][0].input.MessageBody);
}

test('repassa callback_url e notification_url para a fila', async () => {
  const res = await handler({
    body: JSON.stringify({
      ...body,
      callback_url: 'https://app/api/payment/callback/tok',
      notification_url: 'https://app/api/payment/notification',
    }),
  });

  expect(res.statusCode).toBe(202);
  expect(sentMessage()).toMatchObject({
    callback_url: 'https://app/api/payment/callback/tok',
    notification_url: 'https://app/api/payment/notification',
  });
});

test('omite URLs opcionais ausentes', async () => {
  await handler({ body: JSON.stringify(body) });

  expect(sentMessage()).not.toHaveProperty('notification_url');
  expect(sentMessage()).not.toHaveProperty('callback_url');
});
