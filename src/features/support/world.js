const { setWorldConstructor, Before, After, setDefaultTimeout } = require('@cucumber/cucumber');
const { createHmac, randomUUID } = require('crypto');
const { loadDefinition, Execution } = require('./asl-interpreter');
const fakes = require('./aws-fakes');

setDefaultTimeout(10 * 1000);

const ENV = {
  DYNAMODB_TABLE: 'payment-saga-state',
  SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/payment-orders',
  STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:000000000000:stateMachine:payment-saga',
  MP_ACCESS_TOKEN_SECRET_ID: 'payment/mp-access-token',
  MP_WEBHOOK_SECRET_ID: 'payment/mp-webhook-secret',
  WEBHOOK_URL: 'https://api.payment.bdd/webhook',
};

const DLQ_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/payment-orders-dlq';
const WEBHOOK_SECRET = 'segredo-bdd-webhook';

// Mesmos valores padrão de infra/variables.tf
const LINK_RETRY_MAX_ATTEMPTS = 3;
const LINK_RETRY_WAIT_SECONDS = 86400;

const LAMBDA_ARNS = {
  register: 'arn:aws:lambda:us-east-1:000000000000:function:payment-register',
  generateLink: 'arn:aws:lambda:us-east-1:000000000000:function:payment-generate-link',
  notifyWait: 'arn:aws:lambda:us-east-1:000000000000:function:payment-notify-wait',
  cancel: 'arn:aws:lambda:us-east-1:000000000000:function:payment-cancel',
};

// Step Functions em memória: StartExecution roda a ASL real; SendTask* destrava o WaitForTaskToken
class FakeStepFunctions {
  constructor(world) {
    this.world = world;
    this.executions = new Map();
  }

  send(command) {
    const input = command.input;

    switch (command.constructor.name) {
      case 'StartExecutionCommand': {
        if (this.executions.has(input.name)) {
          throw fakes.awsError('ExecutionAlreadyExists', `Execution already exists: '${input.name}'`);
        }
        const execution = new Execution({
          definition: this.world.definition,
          name: input.name,
          input: JSON.parse(input.input),
          lambdas: this.world.lambdas,
          sendToQueue: async (url, body) => this.world.queues.push(url, body),
        });
        this.executions.set(input.name, execution);
        return { executionArn: `${input.stateMachineArn}:${input.name}` };
      }

      case 'SendTaskSuccessCommand':
        return this.complete(input.taskToken, { output: JSON.parse(input.output) });

      case 'SendTaskFailureCommand':
        return this.complete(input.taskToken, { error: input.error, cause: input.cause });

      default:
        throw new Error(`Comando Step Functions nao suportado: ${command.constructor.name}`);
    }
  }

  complete(token, outcome) {
    const done = [...this.executions.values()].some((execution) => execution.completeTask(token, outcome));
    if (!done) throw fakes.awsError('TaskDoesNotExist', 'Task token invalido ou ja utilizado');
    return {};
  }
}

class PaymentSagaWorld {
  constructor() {
    Object.assign(process.env, ENV);

    this.dynamo = new fakes.FakeDynamoTable();
    this.queues = new fakes.FakeQueues();
    this.mercadoPago = new fakes.FakeMercadoPago();
    this.application = new fakes.FakeApplication();
    this.sfn = new FakeStepFunctions(this);

    this.definition = loadDefinition({
      register_function_arn: LAMBDA_ARNS.register,
      generate_link_function_arn: LAMBDA_ARNS.generateLink,
      notify_wait_function_arn: LAMBDA_ARNS.notifyWait,
      cancel_function_arn: LAMBDA_ARNS.cancel,
      dlq_url: DLQ_URL,
      link_retry_max_attempts: LINK_RETRY_MAX_ATTEMPTS,
      link_retry_wait_seconds: LINK_RETRY_WAIT_SECONDS,
    });

    this.lambdas = {
      [LAMBDA_ARNS.register]: (event) => require('../../register').handler(event),
      [LAMBDA_ARNS.generateLink]: (event) => require('../../generate-link').handler(event),
      [LAMBDA_ARNS.notifyWait]: (event) => require('../../notify-wait').handler(event),
      [LAMBDA_ARNS.cancel]: (event) => require('../../cancel').handler(event),
    };

    this.order = null;
    this.lastResponse = null;
    this.lastTriggerResult = null;
  }

  get dlqUrl() {
    return DLQ_URL;
  }

  get retryWaitSeconds() {
    return LINK_RETRY_WAIT_SECONDS;
  }

  // Monta o pedido como o application envia (ServiceOrderPaymentRequester)
  buildOrder({ amountCents, document }) {
    const token = randomUUID().replace(/-/g, '');
    return {
      order_id: randomUUID(),
      amount_cents: amountCents,
      currency: 'BRL',
      description: 'Orcamento OS BDD',
      customer: { name: 'Cliente BDD', email: 'cliente.bdd@example.com', cpf: document },
      items: [{ id: 'svc-1', title: 'Troca de oleo', quantity: 1, unit_price_cents: amountCents }],
      metadata: { source_service: 'tech-challenge-application', service_order_id: randomUUID() },
      created_at: '2026-11-15T12:00:00Z',
      callback_url: `https://app.bdd/api/payment/callback/${token}`,
      notification_url: 'https://app.bdd/api/payment/notification',
    };
  }

  async postOrder(order) {
    const { handler } = require('../../orders');
    this.lastResponse = await handler({ body: JSON.stringify(order) });
    return this.lastResponse;
  }

  async consumeOrdersQueue() {
    const { handler } = require('../../trigger');
    const records = this.queues.drain(ENV.SQS_QUEUE_URL).map((m) => ({ messageId: m.messageId, body: m.body }));
    this.lastTriggerResult = await handler({ Records: records });
    await this.settleAll();
  }

  get execution() {
    const executions = [...this.sfn.executions.values()];
    return executions[executions.length - 1];
  }

  async settleAll() {
    await Promise.all([...this.sfn.executions.values()].map((e) => e.settled()));
  }

  // Webhook do Mercado Pago com assinatura HMAC (x-signature) válida ou inválida
  async mercadoPagoWebhook(paymentId, { validSignature = true } = {}) {
    const { handler } = require('../../callback');
    const requestId = randomUUID();
    const ts = String(Date.now());
    const manifest = `id:${paymentId};request-id:${requestId};ts:${ts};`;
    const secret = validSignature ? WEBHOOK_SECRET : 'segredo-errado';
    const v1 = createHmac('sha256', secret).update(manifest).digest('hex');

    this.lastResponse = await handler({
      headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
      queryStringParameters: { 'data.id': paymentId, type: 'payment' },
      body: JSON.stringify({ type: 'payment', action: 'payment.updated', data: { id: paymentId } }),
    });
    await this.settleAll();
    return this.lastResponse;
  }
}

setWorldConstructor(PaymentSagaWorld);

Before(function () {
  fakes.install({
    dynamo: this.dynamo,
    queues: this.queues,
    sfn: this.sfn,
    mercadoPago: this.mercadoPago,
    application: this.application,
    secrets: {
      [ENV.MP_ACCESS_TOKEN_SECRET_ID]: { access_token: 'TEST-token-bdd' },
      [ENV.MP_WEBHOOK_SECRET_ID]: { webhook_secret: WEBHOOK_SECRET },
    },
  });
  // Logs dos handlers poluem a saída do Cucumber; ficam silenciados durante o cenário
  this.consoleBackup = { info: console.info, warn: console.warn, error: console.error };
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
});

After(function () {
  Object.assign(console, this.consoleBackup);
  fakes.uninstall();
});
