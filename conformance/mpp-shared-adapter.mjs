import { isDeepStrictEqual } from 'node:util';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import * as core from '../packages/mpp/dist/index.js';
import * as buyer from '../packages/mpp-buyer/dist/index.js';
import * as seller from '../packages/mpp-seller/dist/index.js';

const { Credential } = await import(
  createRequire(new URL('../packages/mpp-seller/package.json', import.meta.url)).resolve('mppx')
);

const codecs = new Map([
  ['mpp.core.encode', core.encode],
  ['mpp.core.decode', core.decode],
  ['mpp.core.decode-credential', core.decodeCredential],
  ['mpp.core.decode-receipt', core.decodeReceipt],
  ['mpp.core.parse-challenges', core.parseChallengeHeaders],
]);

export function classify(error, operation, input = {}) {
  let code, message, details;
  if (error instanceof buyer.MppPaymentExpiredError) {
    code = 'payment-expired';
    message = 'Payment expired.';
    if (error.transactionId !== undefined) details = { transaction_id: error.transactionId };
  } else if (error instanceof buyer.MppPaymentTimeoutError) {
    code = 'payment-timeout';
    message = 'Payment timed out.';
    if (error.transactionId !== undefined) details = { transaction_id: error.transactionId };
  } else if (error instanceof buyer.MppPaymentCancelledError) {
    code = 'payment-cancelled';
    message = 'Payment cancelled.';
  } else if (error instanceof buyer.MppMalformedCredentialError) {
    code = 'invalid-credential';
    message = 'Invalid credential.';
  } else if (error instanceof buyer.MppPaymentFailedError) {
    code = 'payment-failed';
    message = 'Payment failed.';
    if (error.problem !== undefined) details = { problem: error.problem };
  } else if (error instanceof core.MppCodecError) {
    code = operation === 'mpp.core.decode-credential' ? 'invalid-credential' : 'invalid-input';
    message = code === 'invalid-credential' ? 'Invalid credential.' : 'Invalid input.';
  } else if (error instanceof seller.MppCredentialProblemError) {
    code = 'payment-failed';
    message = 'Payment failed.';
    if (input.include_problem !== false) details = { problem: error.problem };
  } else if (
    [
      seller.MppUnsupportedCurrencyError,
      seller.MppUnsupportedRailError,
      seller.MppAmbiguousRailError,
      seller.MppInstrumentRequiredError,
    ].some((type) => error instanceof type)
  ) {
    code = 'unsupported-capability';
    message = 'Unsupported payment capability.';
  } else {
    throw error;
  }
  return { code, message, ...(details === undefined ? {} : { details }) };
}

async function execute(operation, input) {
  const codec = codecs.get(operation);
  if (codec) return codec(operation === 'mpp.core.parse-challenges' ? input.headers : input.value);
  if (
    ![
      'mpp.buyer.fulfil',
      'mpp.buyer.cancel',
      'mpp.seller.prepare',
      'mpp.seller.validate',
      'mpp.seller.verify',
      'mpp.seller.route-binding',
    ].includes(operation)
  )
    throw new Error('Unknown MPP operation');
  const base = new URL(input.base_url);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) {
    throw new Error('MPP requests require the loopback platform');
  }
  if (operation.startsWith('mpp.seller.')) return executeSeller(operation, input, base.origin);
  const { method: name, intent } = input.challenge;
  const factory =
    name === 'inflow' && intent === 'charge'
      ? buyer.inflow
      : name === 'inflow' && intent === 'subscription'
        ? buyer.inflow.subscription
        : name === 'tempo' && intent === 'charge'
          ? buyer.tempo
          : undefined;
  if (!factory) throw new Error('Unsupported MPP method and intent');
  let cancellation;
  const method = factory({
    apiKey: input.api_key,
    baseUrl: base.origin,
    pollIntervalMs: 0,
    timeoutMs: input.timeout_ms ?? 5000,
    ...(operation === 'mpp.buyer.cancel'
      ? {
          fetch: async (...args) => {
            const response = await fetch(...args);
            if (
              response.ok &&
              response.headers.get('content-type')?.includes('application/json') &&
              (await response.clone().json()).state === 'pending'
            ) {
              // Let the SDK consume the pending response before cancelling through its public control.
              cancellation = setImmediate(() => method.cleanup());
            }
            return response;
          },
        }
      : {}),
  });
  try {
    const authorization = await method.createCredential({
      challenge: { ...input.challenge, request: core.decode(input.challenge.request) },
      context: input.context,
    });
    if (!authorization.startsWith('Payment ')) throw new Error('Expected Payment authorization');
    return core.decodeCredential(authorization.slice('Payment '.length));
  } finally {
    clearImmediate(cancellation);
    method.cleanup();
  }
}

async function executeSeller(operation, input, baseUrl) {
  const challenge = input.credential?.challenge;
  const name = challenge?.method ?? input.method;
  const intent = challenge?.intent ?? input.intent;
  const factory =
    name === 'inflow' && intent === 'charge'
      ? seller.inflow
      : name === 'inflow' && intent === 'subscription'
        ? seller.inflow.subscription
        : name === 'tempo' && intent === 'charge'
          ? seller.tempo
          : undefined;
  if (!factory) throw new Error('Unsupported MPP method and intent');
  const request = challenge ? core.decode(challenge.request) : input.request;
  const method = factory({ apiKey: input.api_key, baseUrl, currency: request.currency, recipient: request.recipient });
  if (operation === 'mpp.seller.route-binding') {
    const framework = seller.Mppx.create({
      methods: [method],
      secretKey: 'test-only-binding-secret-at-least-32-bytes',
      realm: 'seller.example',
    });
    const issued = await framework.challenge[name][intent](request);
    const authorization = Credential.serialize({
      challenge: issued,
      payload: input.credential_payload,
      source: input.source,
    });
    const response = await framework[intent](input.replacement_request)(
      new Request('https://seller.example/test', { headers: { authorization } }),
    );
    return { status: response.status };
  }
  if (operation === 'mpp.seller.prepare') return method.request({ request });
  const credential = { ...input.credential, challenge: { ...challenge, request } };
  if (operation === 'mpp.seller.verify') return method.verify({ credential, request });
  const value = await method.validate({ credential, request });
  return {
    ...value,
    success: true,
    challenge: { ...value.challenge, request: core.encode(value.challenge.request) },
    credential: {
      ...value.credential,
      challenge: { ...value.credential.challenge, request: core.encode(value.credential.challenge.request) },
    },
  };
}

export async function respond(request) {
  const envelope = { adapter_version: '1', sequence: request.sequence, case_id: request.case_id };
  try {
    if (request.adapter_version !== '1') throw new Error('Unsupported adapter version');
    const before = structuredClone(request.input);
    let observation;
    try {
      observation = { result: await execute(request.operation, request.input) };
    } catch (error) {
      observation = { error: classify(error, request.operation, request.input) };
    }
    if (!isDeepStrictEqual(before, request.input)) throw new Error('Caller input was mutated');
    return { ...envelope, ...observation };
  } catch (error) {
    return { ...envelope, error: { code: 'ADAPTER_ERROR', message: error.message } };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    process.stdout.write(`${JSON.stringify(await respond(JSON.parse(line)))}\n`);
  }
}
