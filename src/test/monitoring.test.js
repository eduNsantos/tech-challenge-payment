describe('monitoring sem agente New Relic', () => {
  test('recordSagaEvent é no-op quando o módulo newrelic não existe', () => {
    jest.isolateModules(() => {
      const { recordSagaEvent } = require('../lib/monitoring');
      expect(() => recordSagaEvent('register', 'PENDING', { orderId: 'o1' })).not.toThrow();
    });
  });
});

describe('monitoring com agente New Relic', () => {
  const recordCustomEvent = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    recordCustomEvent.mockReset();
    jest.doMock('newrelic', () => ({ recordCustomEvent }), { virtual: true });
  });

  afterEach(() => jest.dontMock('newrelic'));

  test('envia evento PaymentSaga sem atributos nulos/indefinidos', () => {
    const { recordSagaEvent } = require('../lib/monitoring');
    recordSagaEvent('callback', 'PAID', { orderId: 'o1', amountCents: 550, mpPaymentId: undefined, currency: null });

    expect(recordCustomEvent).toHaveBeenCalledWith('PaymentSaga', {
      step: 'callback', status: 'PAID', orderId: 'o1', amountCents: 550,
    });
  });

  test('falha do agente não quebra o handler', () => {
    recordCustomEvent.mockImplementation(() => { throw new Error('boom'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { recordSagaEvent } = require('../lib/monitoring');

    expect(() => recordSagaEvent('cancel', 'EXPIRED')).not.toThrow();
    warn.mockRestore();
  });
});

describe('secondsSince', () => {
  test('calcula segundos desde a data ISO', () => {
    const { secondsSince } = require('../lib/monitoring');
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    expect(secondsSince(tenSecondsAgo)).toBe(10);
  });

  test('retorna undefined para data inválida', () => {
    const { secondsSince } = require('../lib/monitoring');
    expect(secondsSince('nao-e-data')).toBeUndefined();
  });
});

describe('serviceOrderId', () => {
  const { serviceOrderId } = require('../lib/monitoring');

  test('devolve o id da O.S. enviado pela aplicação em metadata', () => {
    expect(serviceOrderId({ source_service: 'tech-challenge-application', service_order_id: 'os-1' })).toBe('os-1');
  });

  test('ignora metadata ausente, vazia ou com id inválido', () => {
    expect(serviceOrderId(undefined)).toBeUndefined();
    expect(serviceOrderId({})).toBeUndefined();
    expect(serviceOrderId({ service_order_id: '  ' })).toBeUndefined();
    expect(serviceOrderId({ service_order_id: 123 })).toBeUndefined();
  });
});
