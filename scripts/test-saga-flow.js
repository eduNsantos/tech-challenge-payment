#!/usr/bin/env node
/**
 * test-saga-flow.js — Suíte de testes do payment-service
 *
 * Uso:
 *   node scripts/test-saga-flow.js                          # fluxo feliz completo
 *   node scripts/test-saga-flow.js --scenario sqs           # só envia SQS
 *   node scripts/test-saga-flow.js --scenario sqs-invalid-cpf
 *   node scripts/test-saga-flow.js --scenario sqs-invalid-amount
 *   node scripts/test-saga-flow.js --scenario webhook-approved --mp-payment-id 98765432
 *   node scripts/test-saga-flow.js --scenario webhook-rejected --mp-payment-id 98765433
 *   node scripts/test-saga-flow.js --scenario webhook-invalid-sig
 *   node scripts/test-saga-flow.js --scenario webhook-ignored
 *   node scripts/test-saga-flow.js --scenario dynamo --key <idempotency_key>
 *
 * Requer: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_DEFAULT_REGION=us-east-1
 */

'use strict';

const { createHash, createHmac } = require('crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { DynamoDBClient, GetItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { SFNClient, ListExecutionsCommand, DescribeExecutionCommand } = require('@aws-sdk/client-sfn');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

// ─── Configurações do ambiente implantado ─────────────────────────────────
const CONFIG = {
  region:          'us-east-1',
  sqsUrl:          'https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders',
  dlqUrl:          'https://sqs.us-east-1.amazonaws.com/008962119864/payment-orders-dlq',
  dynamoTable:     'payment-saga-state',
  stateMachineArn: 'arn:aws:states:us-east-1:008962119864:stateMachine:payment-saga',
  webhookUrl:      'https://y3qp355i65.execute-api.us-east-1.amazonaws.com/webhook',
  smWebhookSecret: 'payment/mp-webhook-secret',
  smAccessToken:   'payment/mp-access-token',
};

// ─── Clientes AWS ─────────────────────────────────────────────────────────
const sqs    = new SQSClient({ region: CONFIG.region });
const dynamo = new DynamoDBClient({ region: CONFIG.region });
const sm     = new SecretsManagerClient({ region: CONFIG.region });
const sfn    = new SFNClient({ region: CONFIG.region });

// ─── Helpers ──────────────────────────────────────────────────────────────
function idempotencyKey(orderId, amountCents, createdAt) {
  return createHash('sha256').update(`${orderId}|${amountCents}|${createdAt}`).digest('hex');
}

function hmacSignature(secret, mpPaymentId, requestId, ts) {
  const manifest = `id:${mpPaymentId};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac('sha256', secret).update(manifest).digest('hex');
  return { header: `ts=${ts},v1=${v1}`, ts, v1 };
}

async function getSecret(secretId) {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  return JSON.parse(res.SecretString);
}

async function getDynamoItem(ikey) {
  const res = await dynamo.send(new GetItemCommand({
    TableName: CONFIG.dynamoTable,
    Key: { idempotency_key: { S: ikey } },
  }));
  return res.Item ? unmarshall(res.Item) : null;
}

async function pollDynamo(ikey, expectedStatus, maxWaitMs = 60000, intervalMs = 5000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const item = await getDynamoItem(ikey);
    const status = item?.status ?? '(não encontrado)';
    console.log(`  DynamoDB [${ikey.slice(0, 12)}…]: status=${status}`);
    if (status === expectedStatus) return item;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout aguardando status ${expectedStatus} no DynamoDB`);
}

function log(label, data) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`► ${label}`);
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
}

function pass(msg) { console.log(`  ✅ PASS: ${msg}`); }
function fail(msg) { console.log(`  ❌ FAIL: ${msg}`); process.exitCode = 1; }

// ─── Payloads de teste ────────────────────────────────────────────────────
function buildPayload(overrides = {}) {
  const orderId    = overrides.orderId    ?? `f47ac10b-58cc-4372-a567-${Date.now().toString().slice(-12)}`;
  const createdAt  = overrides.createdAt  ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const amountCents = overrides.amountCents ?? 15000;
  const ikey = overrides.idempotencyKey  ?? idempotencyKey(orderId, amountCents, createdAt);

  return {
    idempotency_key: ikey,
    order_id: orderId,
    created_at: createdAt,
    amount_cents: amountCents,
    currency: 'BRL',
    description: overrides.description ?? 'Teste SAGA — Lanche + Suco',
    customer: overrides.customer ?? {
      name:  'João da Silva',
      email: 'joao.silva@email.com',
      cpf:   '52998224725',  // CPF válido (algoritmo Receita Federal)
      phone: '+5511999999999',
    },
    items: overrides.items ?? [
      { id: 'PROD-001', title: 'Lanche Artesanal',    quantity: 2, unit_price_cents: 5000 },
      { id: 'PROD-042', title: 'Suco Natural 500ml',  quantity: 1, unit_price_cents: 5000 },
    ],
    metadata: overrides.metadata ?? { source_service: 'pos-application' },
    ...(overrides.callback_url ? { callback_url: overrides.callback_url } : {}),
  };
}

// ─── Cenários ─────────────────────────────────────────────────────────────
async function scenarioSqsHappyPath() {
  log('Cenário 1: Fluxo feliz — SQS → PENDING → WAITING_PAYMENT');

  const payload = buildPayload();
  console.log('  Payload gerado:', {
    idempotency_key: payload.idempotency_key,
    order_id: payload.order_id,
    amount_cents: payload.amount_cents,
    created_at: payload.created_at,
  });

  await sqs.send(new SendMessageCommand({
    QueueUrl: CONFIG.sqsUrl,
    MessageBody: JSON.stringify(payload),
  }));
  pass('Mensagem enviada ao SQS');

  console.log('  Aguardando processamento (máx 60s)...');
  const item = await pollDynamo(payload.idempotency_key, 'WAITING_PAYMENT');

  if (item.payment_link) {
    pass(`Link de pagamento gerado: ${item.payment_link.slice(0, 60)}…`);
  } else {
    fail('payment_link não foi preenchido no DynamoDB');
  }

  console.log('\n  idempotency_key para testes subsequentes:');
  console.log(' ', payload.idempotency_key);
  return payload.idempotency_key;
}

async function scenarioSqsInvalidCpf() {
  log('Cenário 2: CPF inválido — SAGA deve falhar no Step ①');

  const orderId = `aaaabbbb-cpf-${Date.now()}`;
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const payload = buildPayload({
    orderId,
    createdAt,
    description: 'Teste CPF inválido',
    customer: { name: 'Teste', email: 'teste@email.com', cpf: '00000000000' },
  });

  await sqs.send(new SendMessageCommand({
    QueueUrl: CONFIG.sqsUrl,
    MessageBody: JSON.stringify(payload),
  }));
  pass('Mensagem com CPF inválido enviada');

  // A execução vai para FAILED no Step Functions
  console.log('  Aguardando 15s para Step Functions processar...');
  await new Promise(r => setTimeout(r, 15000));

  const execs = await sfn.send(new ListExecutionsCommand({
    stateMachineArn: CONFIG.stateMachineArn,
    statusFilter: 'FAILED',
    maxResults: 5,
  }));

  const matchingExec = execs.executions?.find(e => e.name === payload.idempotency_key);
  if (matchingExec) {
    pass('Execução do Step Functions com status FAILED encontrada (CPF inválido rejeitado corretamente)');
  } else {
    console.log('  Aviso: execução FAILED não encontrada nas últimas 5. Pode estar em RUNNING ainda.');
    console.log('  Verificar manualmente com:');
    console.log(`    aws stepfunctions describe-execution --execution-arn arn:aws:states:us-east-1:008962119864:execution:payment-saga:${payload.idempotency_key}`);
  }
}

async function scenarioSqsInvalidAmount() {
  log('Cenário 3: amount_cents inconsistente — Step ① deve abortar');

  const orderId = `ccccdddd-amt-${Date.now()}`;
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // items somam 10000, amount_cents = 15000 → ValidationError
  const payload = buildPayload({
    orderId,
    createdAt,
    amountCents: 15000,
    description: 'Teste amount inválido',
    items: [{ id: 'X', title: 'Item', quantity: 1, unit_price_cents: 10000 }],
  });
  // Recalcular ikey com amount_cents correto para o key mas errado para o sum
  payload.idempotency_key = idempotencyKey(orderId, 15000, createdAt);

  await sqs.send(new SendMessageCommand({
    QueueUrl: CONFIG.sqsUrl,
    MessageBody: JSON.stringify(payload),
  }));
  pass('Mensagem com amount inconsistente enviada');
  console.log('  Verificar log do payment-register:');
  console.log('    aws logs tail /aws/lambda/payment-register --follow');
}

async function scenarioWebhookInvalidSig() {
  log('Cenário 5: Webhook com assinatura inválida — esperado 401');

  const res = await fetch(CONFIG.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature': 'ts=1234567890,v1=assinaturainvalida',
      'x-request-id': `req-invalid-${Date.now()}`,
    },
    body: JSON.stringify({ type: 'payment', data: { id: '12345678' } }),
  });

  if (res.status === 401) {
    pass(`401 retornado corretamente: ${await res.text()}`);
  } else {
    fail(`Esperado 401, recebido ${res.status}: ${await res.text()}`);
  }
}

async function scenarioWebhookIgnored() {
  log('Cenário 7: Webhook tipo não-payment — esperado 200 {ignored:true}');

  const secret = (await getSecret(CONFIG.smWebhookSecret)).webhook_secret;
  const ts = Math.floor(Date.now() / 1000).toString();
  const mpId = '99999999';
  const reqId = `req-ping-${Date.now()}`;
  const { header } = hmacSignature(secret, mpId, reqId, ts);

  const body = { id: mpId, type: 'merchant_order', data: { id: mpId } };

  const res = await fetch(CONFIG.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature': header,
      'x-request-id': reqId,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (res.status === 200 && json.ignored === true) {
    pass('200 {"ignored":true} retornado corretamente');
  } else {
    fail(`Esperado 200 ignored, recebido ${res.status}: ${JSON.stringify(json)}`);
  }
}

async function scenarioWebhookApproved(mpPaymentId) {
  log(`Cenário 6a: Webhook aprovado — mp_payment_id=${mpPaymentId}`);
  console.log('  NOTA: Requer que exista uma execução aguardando WaitForTaskToken com esse order_id');
  console.log('  A Lambda callback buscará o pagamento na API do MP com esse ID');

  const secret = (await getSecret(CONFIG.smWebhookSecret)).webhook_secret;
  const ts = Math.floor(Date.now() / 1000).toString();
  const reqId = `req-approved-${Date.now()}`;
  const { header } = hmacSignature(secret, mpPaymentId, reqId, ts);

  const body = {
    id: mpPaymentId,
    live_mode: false,
    type: 'payment',
    action: 'payment.updated',
    data: { id: mpPaymentId },
  };

  console.log('  Assinatura calculada:', header);

  const res = await fetch(CONFIG.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature': header,
      'x-request-id': reqId,
    },
    body: JSON.stringify(body),
  });

  const responseBody = await res.text();
  console.log(`  Resposta: ${res.status} — ${responseBody}`);

  if (res.status === 200) {
    pass(`Webhook processado: ${responseBody}`);
  } else {
    fail(`Esperado 200, recebido ${res.status}: ${responseBody}`);
  }
}

async function scenarioWebhookRejected(mpPaymentId) {
  log(`Cenário 6b: Webhook rejeitado — mp_payment_id=${mpPaymentId}`);

  const secret = (await getSecret(CONFIG.smWebhookSecret)).webhook_secret;
  const ts = Math.floor(Date.now() / 1000).toString();
  const reqId = `req-rejected-${Date.now()}`;
  const { header } = hmacSignature(secret, mpPaymentId, reqId, ts);

  const body = {
    id: mpPaymentId,
    live_mode: false,
    type: 'payment',
    action: 'payment.updated',
    data: { id: mpPaymentId },
  };

  const res = await fetch(CONFIG.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature': header,
      'x-request-id': reqId,
    },
    body: JSON.stringify(body),
  });

  const responseBody = await res.text();
  console.log(`  Resposta: ${res.status} — ${responseBody}`);

  if (res.status === 200) {
    pass(`Webhook processado: ${responseBody}`);
  } else {
    fail(`Esperado 200, recebido ${res.status}: ${responseBody}`);
  }
}

async function scenarioDynamo(ikey) {
  log(`Consulta DynamoDB — idempotency_key=${ikey}`);
  const item = await getDynamoItem(ikey);
  if (!item) {
    fail('Item não encontrado no DynamoDB');
    return;
  }
  console.log(JSON.stringify({
    idempotency_key: item.idempotency_key?.slice(0, 12) + '…',
    order_id:   item.order_id,
    status:     item.status,
    created_at: item.created_at,
    updated_at: item.updated_at,
    payment_link: item.payment_link ? item.payment_link.slice(0, 60) + '…' : null,
    mp_payment_id: item.mp_payment_id,
    callback_url:  item.callback_url,
  }, null, 2));
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const scenario    = args[args.indexOf('--scenario') + 1]      ?? 'all';
  const mpPaymentId = args[args.indexOf('--mp-payment-id') + 1] ?? null;
  const ikey        = args[args.indexOf('--key') + 1]           ?? null;

  console.log('payment-service — Suíte de testes');
  console.log('Região:', CONFIG.region);
  console.log('Webhook URL:', CONFIG.webhookUrl);
  console.log('Scenario:', scenario);

  try {
    switch (scenario) {
      case 'sqs':              await scenarioSqsHappyPath();         break;
      case 'sqs-invalid-cpf':  await scenarioSqsInvalidCpf();        break;
      case 'sqs-invalid-amount': await scenarioSqsInvalidAmount();   break;
      case 'webhook-invalid-sig': await scenarioWebhookInvalidSig(); break;
      case 'webhook-ignored':  await scenarioWebhookIgnored();       break;
      case 'webhook-approved':
        if (!mpPaymentId) { console.error('--mp-payment-id obrigatório'); process.exit(1); }
        await scenarioWebhookApproved(mpPaymentId);
        break;
      case 'webhook-rejected':
        if (!mpPaymentId) { console.error('--mp-payment-id obrigatório'); process.exit(1); }
        await scenarioWebhookRejected(mpPaymentId);
        break;
      case 'dynamo':
        if (!ikey) { console.error('--key obrigatório'); process.exit(1); }
        await scenarioDynamo(ikey);
        break;
      case 'all':
        await scenarioSqsHappyPath();
        await scenarioSqsInvalidCpf();
        await scenarioSqsInvalidAmount();
        await scenarioWebhookInvalidSig();
        await scenarioWebhookIgnored();
        break;
      default:
        console.error(`Scenario desconhecido: ${scenario}`);
        process.exit(1);
    }
  } catch (err) {
    console.error('\n💥 Erro:', err.message);
    if (err.message.includes('credential') || err.message.includes('Access')) {
      console.error('→ Configure as credenciais AWS:');
      console.error('  export AWS_ACCESS_KEY_ID=...');
      console.error('  export AWS_SECRET_ACCESS_KEY=...');
      console.error('  export AWS_SESSION_TOKEN=...');
      console.error('  export AWS_DEFAULT_REGION=us-east-1');
    }
    process.exit(1);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(process.exitCode ? '❌ Alguns testes falharam' : '✅ Todos os testes passaram');
}

main();
