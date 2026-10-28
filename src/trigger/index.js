const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');

const sfn = new SFNClient({});

exports.handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body);

      await sfn.send(new StartExecutionCommand({
        stateMachineArn: process.env.STATE_MACHINE_ARN,
        name: body.idempotency_key,
        input: JSON.stringify(body),
      }));
    } catch (err) {
      // ExecutionAlreadyExists = mensagem duplicada, idempotente — não re-enfileira
      if (err.name === 'ExecutionAlreadyExists') {
        console.info(`Execucao duplicada ignorada: ${record.messageId}`);
        continue;
      }

      console.error(`Falha ao processar mensagem ${record.messageId}:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
