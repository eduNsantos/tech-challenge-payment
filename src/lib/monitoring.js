// Eventos de negócio da SAGA para o New Relic.
// O agente `newrelic` vem da Lambda layer do New Relic (não é dependência do package.json).
// Sem a layer (monitoramento desligado, testes locais), todas as funções viram no-op.

let newrelic = null;
try {
  newrelic = require('newrelic');
} catch {
  newrelic = null;
}

const EVENT_TYPE = 'PaymentSaga';

// Nunca enviar dados pessoais (customer, documento, e-mail) — só identificadores e valores.
function recordSagaEvent(step, status, attrs = {}) {
  if (!newrelic) return;

  const event = { step, status };
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) event[key] = value;
  }

  try {
    newrelic.recordCustomEvent(EVENT_TYPE, event);
  } catch (err) {
    console.warn(`Falha ao registrar evento no New Relic: ${err.message}`);
  }
}

// Segundos entre created_at do pedido e agora — usado para medir tempo até PAID/REJECTED/EXPIRED.
function secondsSince(isoDate) {
  const start = Date.parse(isoDate);
  if (Number.isNaN(start)) return undefined;
  return Math.round((Date.now() - start) / 1000);
}

module.exports = { recordSagaEvent, secondsSince };
