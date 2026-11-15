// Interpretador mínimo de Amazon States Language para os testes BDD.
//
// Executa a MESMA definição que o Terraform publica (infra/state-machine/payment-saga.asl.json),
// chamando os handlers reais das Lambdas. Cobre só o que a payment-saga usa:
// Task (lambda:invoke, lambda:invoke.waitForTaskToken, sqs:sendMessage), Pass, Choice, Wait,
// Succeed e Fail, com Retry, Catch, ResultPath, Parameters (".$") e as funções intrínsecas
// States.MathAdd e States.JsonToString. Esperas (Wait e intervalos de Retry) não dormem:
// ficam registradas no histórico para as asserções.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const ASL_PATH = path.resolve(__dirname, '../../../infra/state-machine/payment-saga.asl.json');

// Renderiza o template como o templatefile() do Terraform
function loadDefinition(vars) {
  const template = fs.readFileSync(ASL_PATH, 'utf8');
  const rendered = template.replace(/\$\{(\w+)\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`Variavel ${name} nao informada para o template da ASL`);
    return vars[name];
  });
  return JSON.parse(rendered);
}

class StatesError extends Error {
  constructor(error, cause) {
    super(cause ?? error);
    this.name = error;
    this.cause = cause;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function readPath(data, jsonPath, context) {
  if (jsonPath === '$') return data;
  if (jsonPath === '$$') return context;
  const [root, rest] = jsonPath.startsWith('$$.') ? [context, jsonPath.slice(3)] : [data, jsonPath.slice(2)];
  return rest.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), root);
}

function writePath(data, jsonPath, value) {
  if (jsonPath === '$') return value;
  const out = clone(data) ?? {};
  const keys = jsonPath.slice(2).split('.');
  let node = out;
  keys.slice(0, -1).forEach((key) => {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  });
  node[keys[keys.length - 1]] = value;
  return out;
}

function applyResultPath(input, result, resultPath) {
  if (resultPath === null) return input;
  return writePath(input, resultPath ?? '$', result);
}

function intrinsic(expression, data, context) {
  const match = /^(States\.\w+)\((.*)\)$/.exec(expression);
  if (!match) return readPath(data, expression, context);
  const [, fn, rawArgs] = match;
  const args = rawArgs.split(',').map((a) => a.trim()).map((a) =>
    (a.startsWith('$') ? readPath(data, a, context) : JSON.parse(a)));

  switch (fn) {
    case 'States.MathAdd': return args[0] + args[1];
    case 'States.JsonToString': return JSON.stringify(args[0]);
    default: throw new Error(`Funcao intrinseca nao suportada: ${fn}`);
  }
}

function resolveParameters(template, data, context) {
  if (Array.isArray(template)) return template.map((v) => resolveParameters(v, data, context));
  if (template === null || typeof template !== 'object') return template;

  return Object.fromEntries(Object.entries(template).map(([key, value]) => (
    key.endsWith('.$')
      ? [key.slice(0, -2), intrinsic(value, data, context)]
      : [key, resolveParameters(value, data, context)]
  )));
}

function matches(errorEquals, errorName) {
  return errorEquals.includes(errorName)
    || errorEquals.includes('States.ALL')
    || (errorEquals.includes('States.TaskFailed') && !errorName.startsWith('States.'));
}

const CHOICE_OPERATORS = {
  NumericLessThan: (a, b) => a < b,
  NumericEquals: (a, b) => a === b,
  NumericGreaterThanEquals: (a, b) => a >= b,
  StringEquals: (a, b) => a === b,
  BooleanEquals: (a, b) => a === b,
};

function evaluateChoice(rule, data, context) {
  const value = readPath(data, rule.Variable, context);
  const operator = Object.keys(CHOICE_OPERATORS).find((op) => op in rule);
  if (!operator) throw new Error(`Operador de Choice nao suportado: ${JSON.stringify(rule)}`);
  return CHOICE_OPERATORS[operator](value, rule[operator]);
}

class Execution {
  constructor({ definition, name, input, lambdas, sendToQueue }) {
    this.definition = definition;
    this.name = name;
    this.input = input;
    this.lambdas = lambdas;
    this.sendToQueue = sendToQueue;
    this.status = 'RUNNING';
    this.history = [];
    this.output = undefined;
    this.error = undefined;
    this.pendingTask = null;
    this.done = this.run().catch((err) => {
      this.status = 'FAILED';
      this.error = { Error: 'InterpreterError', Cause: err.stack };
    });
  }

  record(event) {
    this.history.push(event);
  }

  statesVisited() {
    return this.history.filter((e) => e.type === 'StateEntered').map((e) => e.state);
  }

  // Resolve um WaitForTaskToken (SendTaskSuccess / SendTaskFailure / timeout)
  completeTask(token, outcome) {
    if (!this.pendingTask || this.pendingTask.token !== token) return false;
    const { resolve, reject } = this.pendingTask;
    this.pendingTask = null;
    this.status = 'RUNNING';
    if (outcome.error) reject(new StatesError(outcome.error, outcome.cause));
    else resolve(outcome.output);
    return true;
  }

  expireTask(errorName) {
    if (!this.pendingTask) throw new Error('Nenhuma tarefa aguardando token');
    return this.completeTask(this.pendingTask.token, { error: errorName, cause: 'Tempo de espera esgotado' });
  }

  async run() {
    let stateName = this.definition.StartAt;
    let data = clone(this.input);

    for (;;) {
      const state = this.definition.States[stateName];
      if (!state) throw new Error(`Estado inexistente: ${stateName}`);
      this.record({ type: 'StateEntered', state: stateName });

      switch (state.Type) {
        case 'Pass': {
          const result = state.Parameters
            ? resolveParameters(state.Parameters, data, {})
            : (state.Result !== undefined ? clone(state.Result) : data);
          data = applyResultPath(data, result, state.ResultPath);
          break;
        }

        case 'Wait':
          this.record({ type: 'WaitStarted', state: stateName, seconds: state.Seconds });
          break;

        case 'Choice': {
          const choice = state.Choices.find((rule) => evaluateChoice(rule, data, {}));
          stateName = choice ? choice.Next : state.Default;
          continue;
        }

        case 'Succeed':
          this.status = 'SUCCEEDED';
          this.output = data;
          return;

        case 'Fail':
          this.status = 'FAILED';
          this.error = { Error: state.Error, Cause: state.Cause };
          this.output = data;
          return;

        case 'Task': {
          const outcome = await this.runTask(stateName, state, data);
          if (outcome.next) {
            data = outcome.data;
            stateName = outcome.next;
            continue;
          }
          data = applyResultPath(data, outcome.result, state.ResultPath);
          break;
        }

        default:
          throw new Error(`Tipo de estado nao suportado: ${state.Type}`);
      }

      if (state.End) {
        this.status = 'SUCCEEDED';
        this.output = data;
        return;
      }
      stateName = state.Next;
    }
  }

  // Executa a Task com Retry; esgotadas as tentativas, aplica o Catch
  async runTask(stateName, state, data) {
    const attempts = new Map();

    for (;;) {
      try {
        const result = await this.invoke(stateName, state, data);
        return { result };
      } catch (err) {
        const errorName = err instanceof StatesError ? err.name : (err.name || 'Error');
        this.record({ type: 'TaskFailed', state: stateName, error: errorName, cause: err.message });

        const retrier = (state.Retry ?? []).find((r) => matches(r.ErrorEquals, errorName));
        if (retrier) {
          const count = attempts.get(retrier) ?? 0;
          if (count < (retrier.MaxAttempts ?? 3)) {
            attempts.set(retrier, count + 1);
            this.record({ type: 'TaskRetry', state: stateName, attempt: count + 1 });
            continue;
          }
        }

        const catcher = (state.Catch ?? []).find((c) => matches(c.ErrorEquals, errorName));
        if (!catcher) {
          throw new StatesError(errorName, err.message);
        }
        const errorOutput = { Error: errorName, Cause: err.message };
        return { next: catcher.Next, data: applyResultPath(data, errorOutput, catcher.ResultPath) };
      }
    }
  }

  async invoke(stateName, state, data) {
    const context = {};
    const waitForToken = state.Resource.endsWith('.waitForTaskToken');
    if (waitForToken) context.Task = { Token: randomUUID() };

    const params = resolveParameters(state.Parameters ?? {}, data, context);

    if (state.Resource.startsWith('arn:aws:states:::lambda:invoke')) {
      const handler = this.lambdas[params.FunctionName];
      if (!handler) throw new Error(`Lambda nao registrada: ${params.FunctionName}`);

      const payload = await handler(clone(params.Payload));
      if (!waitForToken) return { Payload: payload ?? null, StatusCode: 200 };

      this.status = 'WAITING';
      this.record({ type: 'TaskWaitingForToken', state: stateName });
      return new Promise((resolve, reject) => {
        this.pendingTask = { token: context.Task.Token, resolve, reject };
      });
    }

    if (state.Resource === 'arn:aws:states:::sqs:sendMessage') {
      await this.sendToQueue(params.QueueUrl, params.MessageBody);
      return { MessageId: randomUUID() };
    }

    throw new Error(`Resource nao suportado: ${state.Resource}`);
  }

  // Aguarda a execução parar (fim ou espera por token)
  async settled() {
    for (let i = 0; i < 10000 && this.status === 'RUNNING'; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (this.status === 'RUNNING') throw new Error('Execucao nao estabilizou');
  }
}

module.exports = { loadDefinition, Execution };
