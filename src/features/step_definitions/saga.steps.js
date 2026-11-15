const { Given, When, Then } = require('@cucumber/cucumber');
const assert = require('node:assert/strict');

// ── Pré-condições ────────────────────────────────────────────────────────────

Given('que o Mercado Pago está disponível', function () {
  this.mercadoPago.failNext(0);
});

Given('que o application está no ar', function () {
  this.application.available = true;
});

Given('que o Mercado Pago vai falhar nas próximas {int} chamadas', function (times) {
  this.mercadoPago.failNext(times);
});

Given('que o Mercado Pago está fora do ar', function () {
  this.mercadoPago.failNext(Infinity);
});

Given('uma saga aguardando o pagamento de {int} centavos', async function (amountCents) {
  this.order = this.buildOrder({ amountCents, document: '52998224725' });
  await this.postOrder(this.order);
  await this.consumeOrdersQueue();
  assert.equal(this.execution.status, 'WAITING');
});

// ── application → payment-service ───────────────────────────────────────────

When('o application solicita a cobrança de {int} centavos para o CPF {string}', async function (amountCents, document) {
  this.order = this.buildOrder({ amountCents, document });
  await this.postOrder(this.order);
});

When('o application solicita a mesma cobrança de {int} centavos {int} vezes', async function (amountCents, times) {
  this.order = this.buildOrder({ amountCents, document: '52998224725' });
  for (let i = 0; i < times; i++) {
    const response = await this.postOrder(this.order);
    assert.equal(response.statusCode, 202);
  }
});

When('o trigger consome a fila de pedidos', async function () {
  await this.consumeOrdersQueue();
});

Then('a API deve aceitar o pedido com status {string}', function (status) {
  assert.equal(this.lastResponse.statusCode, 202);
  const body = JSON.parse(this.lastResponse.body);
  assert.equal(body.status, status);
  assert.equal(body.order_id, this.order.order_id);
  assert.match(body.idempotency_key, /^[0-9a-f]{64}$/);
});

// ── Mercado Pago → payment-service ──────────────────────────────────────────

When('o Mercado Pago notifica o pagamento com status {string}', async function (status) {
  const paymentId = String(Date.now());
  this.mercadoPago.payments.set(paymentId, {
    id: paymentId,
    external_reference: this.order.order_id,
    status,
    status_detail: status === 'approved' ? 'accredited' : `cc_${status}`,
    payment_type_id: 'credit_card',
  });
  await this.mercadoPagoWebhook(paymentId);
});

When('alguém envia um webhook de pagamento {string} com assinatura inválida', async function (status) {
  const paymentId = String(Date.now());
  this.mercadoPago.payments.set(paymentId, { id: paymentId, external_reference: this.order.order_id, status });
  await this.mercadoPagoWebhook(paymentId, { validSignature: false });
});

When('o prazo de pagamento se esgota', async function () {
  // HeartbeatSeconds (30 min sem sinal) / TimeoutSeconds (48 h) da tarefa NotificarEAguardar
  this.execution.expireTask('States.HeartbeatTimeout');
  await this.settleAll();
});

Then('o webhook deve responder {int}', function (statusCode) {
  assert.equal(this.lastResponse.statusCode, statusCode);
});

// ── Estado da saga ──────────────────────────────────────────────────────────

Then('a saga deve ficar aguardando o pagamento', function () {
  assert.equal(this.execution.status, 'WAITING', JSON.stringify(this.execution.error));
  assert.equal(this.execution.statesVisited().at(-1), 'NotificarEAguardar');
});

Then('a saga deve terminar com sucesso', function () {
  assert.equal(this.execution.status, 'SUCCEEDED', JSON.stringify(this.execution.error));
});

Then('a saga deve terminar com falha {string}', function (error) {
  assert.equal(this.execution.status, 'FAILED');
  assert.equal(this.execution.error.Error, error, JSON.stringify(this.execution.error));
});

Then('o erro registrado na saga deve ser {string}', function (error) {
  assert.equal(this.execution.output.error.Error, error);
});

Then('a saga deve ter passado pelos estados:', function (table) {
  assert.deepEqual(this.execution.statesVisited(), table.raw().map(([state]) => state));
});

Then('apenas {int} saga deve ter sido iniciada', function (count) {
  assert.equal(this.sfn.executions.size, count);
});

Then('o trigger não deve devolver mensagens para a fila', function () {
  assert.deepEqual(this.lastTriggerResult, { batchItemFailures: [] });
});

Then('o Mercado Pago deve ter sido chamado {int} vezes', function (times) {
  assert.equal(this.mercadoPago.preferenceCalls, times);
});

Then('o Mercado Pago não deve ser chamado', function () {
  assert.equal(this.mercadoPago.preferenceCalls, 0);
});

Then('a saga não deve ter aguardado nova tentativa diária', function () {
  assert.equal(waits(this.execution).length, 0);
});

Then(/^a saga deve ter aguardado (\d+) (?:nova tentativa diária|novas tentativas diárias)$/, function (count) {
  const found = waits(this.execution);
  assert.equal(found.length, Number(count));
  found.forEach((w) => assert.equal(w.seconds, this.retryWaitSeconds));
});

// ── DynamoDB e DLQ ──────────────────────────────────────────────────────────

Then('o pedido deve estar com status {string} no DynamoDB', function (status) {
  const record = [...this.dynamo.items.values()].find((item) => item.order_id === this.order.order_id);
  assert.ok(record, 'pedido nao encontrado no DynamoDB');
  assert.equal(record.status, status);
});

Then('nenhum pedido deve estar gravado no DynamoDB', function () {
  assert.equal(this.dynamo.items.size, 0);
});

Then('nenhuma mensagem deve ir para a DLQ', function () {
  assert.equal(this.queues.peek(this.dlqUrl).length, 0);
});

Then('a DLQ deve receber o pedido com o erro {string}', function (error) {
  const messages = this.queues.peek(this.dlqUrl).map((m) => JSON.parse(m.body));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].order_id, this.order.order_id);
  assert.equal(messages[0].error.Error, error);
});

// ── payment-service → application ───────────────────────────────────────────

Then('o application deve receber o link de pagamento', function () {
  const notifications = this.application.to(this.order.notification_url);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].order_id, this.order.order_id);
  assert.equal(notifications[0].status, 'WAITING_PAYMENT');
  assert.match(notifications[0].payment_link, /^https:\/\/sandbox\.mercadopago\.com\.br\//);
});

Then('o application não deve receber o link de pagamento', function () {
  assert.equal(this.application.to(this.order.notification_url).length, 0);
});

Then('o application deve receber o resultado {string}', function (status) {
  const results = this.application.to(this.order.callback_url);
  assert.equal(results.length, 1);
  assert.equal(results[0].order_id, this.order.order_id);
  assert.equal(results[0].status, status);
});

Then('o application não deve receber resultado do pagamento', function () {
  assert.equal(this.application.to(this.order.callback_url).length, 0);
});

function waits(execution) {
  return execution.history.filter((e) => e.type === 'WaitStarted');
}
