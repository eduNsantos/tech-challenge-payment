// Substitutos em memória da AWS e do Mercado Pago para os testes BDD.
//
// Os handlers criam os clientes do SDK no escopo do módulo (new DynamoDBClient({})).
// Em vez de mockar os módulos, sobrescrevemos o método send() no prototype de cada
// cliente: as instâncias já criadas passam a falar com os fakes abaixo.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { SFNClient } = require('@aws-sdk/client-sfn');
const { SQSClient } = require('@aws-sdk/client-sqs');
const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { randomUUID } = require('crypto');

const awsError = (name, message) => Object.assign(new Error(message ?? name), { name });

class FakeDynamoTable {
  constructor() {
    this.items = new Map();
  }

  get(key) {
    return this.items.get(key);
  }

  send(command) {
    const input = command.input;

    switch (command.constructor.name) {
      case 'PutItemCommand': {
        const item = unmarshall(input.Item);
        if (input.ConditionExpression === 'attribute_not_exists(idempotency_key)' && this.items.has(item.idempotency_key)) {
          throw awsError('ConditionalCheckFailedException');
        }
        this.items.set(item.idempotency_key, item);
        return {};
      }

      case 'GetItemCommand': {
        const { idempotency_key } = unmarshall(input.Key);
        const item = this.items.get(idempotency_key);
        return item ? { Item: marshall(item, { removeUndefinedValues: true }) } : {};
      }

      case 'UpdateItemCommand': {
        const { idempotency_key } = unmarshall(input.Key);
        const values = unmarshall(input.ExpressionAttributeValues);
        const names = input.ExpressionAttributeNames ?? {};
        const item = { ...(this.items.get(idempotency_key) ?? { idempotency_key }) };

        input.UpdateExpression.replace(/^SET\s+/, '').split(',').forEach((assignment) => {
          const [rawName, rawValue] = assignment.split('=').map((s) => s.trim());
          item[names[rawName] ?? rawName] = values[rawValue];
        });

        this.items.set(idempotency_key, item);
        return {};
      }

      case 'QueryCommand': {
        if (input.IndexName !== 'order_id-index') throw new Error(`Indice nao suportado: ${input.IndexName}`);
        const { ':oid': orderId } = unmarshall(input.ExpressionAttributeValues);
        const found = [...this.items.values()].filter((item) => item.order_id === orderId);
        return { Items: found.map((item) => marshall(item, { removeUndefinedValues: true })) };
      }

      default:
        throw new Error(`Comando DynamoDB nao suportado: ${command.constructor.name}`);
    }
  }
}

class FakeQueues {
  constructor() {
    this.messages = new Map();
  }

  push(queueUrl, body) {
    const list = this.messages.get(queueUrl) ?? [];
    list.push({ messageId: randomUUID(), body });
    this.messages.set(queueUrl, list);
  }

  drain(queueUrl) {
    const list = this.messages.get(queueUrl) ?? [];
    this.messages.set(queueUrl, []);
    return list;
  }

  peek(queueUrl) {
    return this.messages.get(queueUrl) ?? [];
  }

  send(command) {
    if (command.constructor.name !== 'SendMessageCommand') {
      throw new Error(`Comando SQS nao suportado: ${command.constructor.name}`);
    }
    this.push(command.input.QueueUrl, command.input.MessageBody);
    return { MessageId: randomUUID() };
  }
}

// Mercado Pago: preferências (link) e consulta de pagamentos
class FakeMercadoPago {
  constructor() {
    this.failuresLeft = 0;
    this.preferenceCalls = 0;
    this.payments = new Map();
    this.cancelledPayments = [];
  }

  failNext(times) {
    this.failuresLeft = times;
  }

  async handle(url, init) {
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url === 'https://api.mercadopago.com/checkout/preferences' && method === 'POST') {
      this.preferenceCalls += 1;
      if (this.failuresLeft > 0) {
        this.failuresLeft -= 1;
        return response(503, { message: 'service unavailable' });
      }
      const id = `pref-${this.preferenceCalls}`;
      return response(201, {
        id,
        init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${id}`,
        sandbox_init_point: `https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=${id}`,
      });
    }

    const payment = /^https:\/\/api\.mercadopago\.com\/v1\/payments\/(.+)$/.exec(url);
    if (payment && method === 'GET') {
      const found = this.payments.get(payment[1]);
      return found ? response(200, found) : response(404, { message: 'not found' });
    }
    if (payment && method === 'PUT') {
      this.cancelledPayments.push(payment[1]);
      return response(200, {});
    }

    return null;
  }
}

// Tudo que não é Mercado Pago é tratado como chamada ao application (notification_url / callback_url)
class FakeApplication {
  constructor() {
    this.received = [];
    this.available = true;
  }

  async handle(url, init) {
    this.received.push({ url, body: JSON.parse(init?.body ?? '{}') });
    return this.available ? response(200, { ok: true }) : response(503, {});
  }

  to(url) {
    return this.received.filter((r) => r.url === url).map((r) => r.body);
  }
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const originals = {};

function install({ dynamo, queues, sfn, secrets, mercadoPago, application }) {
  originals.dynamo = DynamoDBClient.prototype.send;
  originals.sqs = SQSClient.prototype.send;
  originals.sfn = SFNClient.prototype.send;
  originals.secrets = SecretsManagerClient.prototype.send;
  originals.fetch = global.fetch;

  DynamoDBClient.prototype.send = async (command) => dynamo.send(command);
  SQSClient.prototype.send = async (command) => queues.send(command);
  SFNClient.prototype.send = async (command) => sfn.send(command);
  SecretsManagerClient.prototype.send = async (command) => ({ SecretString: JSON.stringify(secrets[command.input.SecretId]) });
  global.fetch = async (url, init) => (await mercadoPago.handle(String(url), init)) ?? application.handle(String(url), init);
}

function uninstall() {
  DynamoDBClient.prototype.send = originals.dynamo;
  SQSClient.prototype.send = originals.sqs;
  SFNClient.prototype.send = originals.sfn;
  SecretsManagerClient.prototype.send = originals.secrets;
  global.fetch = originals.fetch;
}

module.exports = { FakeDynamoTable, FakeQueues, FakeMercadoPago, FakeApplication, install, uninstall, awsError };
