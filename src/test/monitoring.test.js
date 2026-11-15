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
