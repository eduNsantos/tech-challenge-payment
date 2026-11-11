const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');

const dynamo = new DynamoDBClient({});

exports.handler = async (event) => {
  const { taskToken, input } = event;
  const { idempotency_key, order_id, payment_link, notification_url } = input;
  const initPoint = payment_link?.Payload?.init_point ?? null;

  // Armazena o task token no DynamoDB para o lambda-callback resolver depois
  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.DYNAMODB_TABLE,
    Key: marshall({ idempotency_key }),
    UpdateExpression: 'SET #s = :s, task_token = :t, payment_link = :l, updated_at = :u',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({
      ':s': 'WAITING_PAYMENT',
      ':t': taskToken,
      ':l': initPoint,
      ':u': new Date().toISOString(),
    }),
  }));

  // Notifica o servico de origem com o link de pagamento.
  // A URL vem na propria mensagem (notification_url); APP_NOTIFICATION_URL fica como fallback global.
  const notifyUrl = notification_url || process.env.APP_NOTIFICATION_URL;
  if (notifyUrl) {
    try {
      const res = await fetch(notifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id, payment_link: initPoint, status: 'WAITING_PAYMENT' }),
      });

      if (!res.ok) {
        console.warn(`App notification failed with status ${res.status} for order ${order_id}`);
      }
    } catch (err) {
      console.warn(`App notification failed for order ${order_id}: ${err.message}`);
    }
  } else {
    console.warn(`Sem notification_url/APP_NOTIFICATION_URL para order ${order_id} — link nao entregue ao app`);
  }

  // Retorna imediatamente — Step Functions aguarda pelo task token
};
