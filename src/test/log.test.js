const { log, describeError, describeUrl, postJson } = require('../shared/log');

describe('shared/log', () => {
  let info, warn, error;

  beforeEach(() => {
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  describe('log', () => {
    it('escreve uma linha JSON no nível correspondente', () => {
      log.info('evento_info', { order_id: 'o-1' });
      log.warn('evento_warn');
      log.error('evento_error', { reason: 'x' });

      expect(JSON.parse(info.mock.calls[0][0])).toEqual({ level: 'info', event: 'evento_info', order_id: 'o-1' });
      expect(JSON.parse(warn.mock.calls[0][0])).toEqual({ level: 'warn', event: 'evento_warn' });
      expect(JSON.parse(error.mock.calls[0][0])).toEqual({ level: 'error', event: 'evento_error', reason: 'x' });
    });
  });

  describe('describeError', () => {
    it('retorna objeto vazio sem erro', () => {
      expect(describeError(undefined)).toEqual({});
    });

    it('expõe nome e mensagem do erro', () => {
      expect(describeError(new TypeError('falhou'))).toEqual({ error_name: 'TypeError', error_message: 'falhou' });
    });

    it('expõe a causa escondida pelo fetch', () => {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' };
      expect(describeError(err)).toMatchObject({ error_code: 'ECONNREFUSED', error_cause: 'connect ECONNREFUSED' });
    });

    it('converte causa sem code/message para texto', () => {
      const err = new Error('x');
      err.cause = 'timeout';
      expect(describeError(err)).toMatchObject({ error_code: null, error_cause: 'timeout' });
    });
  });

  describe('describeUrl', () => {
    it('retorna host nulo sem URL', () => {
      expect(describeUrl(null)).toEqual({ url_host: null });
    });

    it('mascara o token do callback e remove a query', () => {
      expect(describeUrl('https://app.example.com/api/payment/callback/abc123?x=1')).toEqual({
        url_host: 'app.example.com',
        url_path: '/api/payment/callback/***',
        url_unreachable_from_lambda: false,
      });
    });

    it('sinaliza host privado como inalcançável pela Lambda', () => {
      expect(describeUrl('http://localhost:8080/api').url_unreachable_from_lambda).toBe(true);
      expect(describeUrl('http://192.168.0.10/api').url_unreachable_from_lambda).toBe(true);
    });

    it('trata URL inválida', () => {
      expect(describeUrl('não é url')).toEqual({ url_host: 'invalid', url_unreachable_from_lambda: true });
    });
  });

  describe('postJson', () => {
    const url = 'https://app.example.com/api/payment/notification';

    it('retorna true e registra sucesso', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      await expect(postJson(url, { a: 1 }, { order_id: 'o-1' })).resolves.toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST', body: '{"a":1}' }));
      expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({ event: 'http_post_ok', http_status: 200, order_id: 'o-1' });
    });

    it('retorna false e registra status e corpo quando a resposta não é 2xx', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('erro interno') });

      await expect(postJson(url, {}, {})).resolves.toBe(false);
      expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({ event: 'http_post_failed', http_status: 500, response_body: 'erro interno' });
    });

    it('retorna false e registra a causa quando a rede falha', async () => {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' };
      global.fetch = jest.fn().mockRejectedValue(err);

      await expect(postJson(url, {}, {})).resolves.toBe(false);
      expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({ event: 'http_post_failed', error_code: 'ENOTFOUND' });
    });
  });
});
