const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
  PutItemCommand: jest.fn((input) => ({ input })),
}));

const { handler, validateCnpj, resolveDocumentType } = require('../register');

const VALID_CPF = '52998224725';
const VALID_CNPJ = '11222333000181';

function event(customer) {
  return {
    idempotency_key: 'k1',
    order_id: 'o1',
    amount_cents: 550,
    currency: 'BRL',
    description: 'Teste',
    customer: { name: 'Cliente', email: 'c@example.com', ...customer },
    items: [{ id: 'i1', title: 'Item', quantity: 1, unit_price_cents: 550 }],
    created_at: '2026-11-11T10:00:00Z',
  };
}

beforeEach(() => mockSend.mockReset().mockResolvedValue({}));

describe('validateCnpj', () => {
  test('aceita CNPJ válido', () => expect(validateCnpj(VALID_CNPJ)).toBe(true));
  test('rejeita dígito verificador errado', () => expect(validateCnpj('11222333000182')).toBe(false));
  test('rejeita dígitos repetidos', () => expect(validateCnpj('11111111111111')).toBe(false));
});

describe('resolveDocumentType', () => {
  test('infere CPF', () => expect(resolveDocumentType({ cpf: VALID_CPF })).toBe('CPF'));
  test('infere CNPJ', () => expect(resolveDocumentType({ cpf: VALID_CNPJ })).toBe('CNPJ'));
  test('rejeita document_type divergente do tamanho', () =>
    expect(resolveDocumentType({ cpf: VALID_CNPJ, document_type: 'CPF' })).toBeNull());
});

describe('handler', () => {
  test('registra cliente com CNPJ e persiste document_type', async () => {
    await handler(event({ cpf: VALID_CNPJ }));

    const item = mockSend.mock.calls[0][0].input.Item;
    expect(item.customer.M.document_type.S).toBe('CNPJ');
    expect(item.status.S).toBe('PENDING');
  });

  test('aborta com InvalidDocument para documento inválido', async () => {
    await expect(handler(event({ cpf: '12345678900' }))).rejects.toMatchObject({ name: 'InvalidDocument' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
