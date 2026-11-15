// Logs estruturados (JSON, uma linha) para o CloudWatch Logs Insights:
//   fields @timestamp, event, order_id, reason | filter order_id = '...'
// Nunca registra customer, CPF/CNPJ, task token nem o token do callback_url.

function write(level, event, fields = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

const log = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
};

// fetch() do Node falha com "fetch failed" e esconde a causa em err.cause.
function describeError(err) {
  if (!err) return {};
  return {
    error_name: err.name,
    error_message: err.message,
    ...(err.cause && {
      error_code: err.cause.code ?? null,
      error_cause: err.cause.message ?? String(err.cause),
    }),
  };
}

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|host\.docker\.internal|\[?::1\]?)/i;

// Só origem e caminho, sem query nem segmentos após /callback/ (contêm token).
function describeUrl(url) {
  if (!url) return { url_host: null };
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/(\/callback\/)[^/]+/, '$1***');
    return {
      url_host: u.host,
      url_path: path,
      // Lambda não alcança localhost/rede privada: esse é o erro mais comum de configuração.
      url_unreachable_from_lambda: PRIVATE_HOST.test(u.hostname),
    };
  } catch {
    return { url_host: 'invalid', url_unreachable_from_lambda: true };
  }
}

// POST best-effort com log do resultado (sucesso, status HTTP ou causa da falha de rede).
async function postJson(url, payload, fields) {
  const target = describeUrl(url);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const outcome = { ...fields, ...target, http_status: res.status, duration_ms: Date.now() - started };
    if (res.ok) log.info('http_post_ok', outcome);
    else log.warn('http_post_failed', { ...outcome, response_body: (await res.text().catch(() => '')).slice(0, 500) });
    return res.ok;
  } catch (err) {
    log.warn('http_post_failed', { ...fields, ...target, duration_ms: Date.now() - started, ...describeError(err) });
    return false;
  }
}

module.exports = { log, describeError, describeUrl, postJson };
