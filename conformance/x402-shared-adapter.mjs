import { isDeepStrictEqual } from 'node:util';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { InflowApiError } from '../packages/x402/dist/index.js';
import { PAYMENT_IDENTIFIER, validatePaymentId } from '../packages/x402/dist/extensions/index.js';
import * as buyer from '../packages/x402-buyer/dist/index.js';

export function classify(error) {
  if (error instanceof InflowApiError)
    return {
      code: 'api-error',
      message: 'InFlow API request failed.',
      http_status: error.httpStatus,
      details: { body: error.body },
    };
  if (error instanceof buyer.X402ApprovalFailedError)
    return { code: 'payment-failed', message: 'Payment failed.', details: { status: error.status } };
  if (error instanceof buyer.X402ApprovalTimeoutError)
    return { code: 'payment-timeout', message: 'Payment timed out.' };
  if (error instanceof buyer.X402ApprovalCancelledError)
    return { code: 'payment-cancelled', message: 'Payment cancelled.' };
  if (error instanceof buyer.X402PaymentIdFormatError) return { code: 'invalid-input', message: 'Invalid input.' };
  if (error instanceof buyer.X402AdapterRoutingError)
    return { code: 'unsupported-capability', message: 'Unsupported payment capability.' };
  throw error;
}

async function execute(operation, input) {
  if (operation === 'x402.core.identifier-valid') return validatePaymentId(input.value);
  if (operation === 'x402.core.identifier-declaration') return PAYMENT_IDENTIFIER.buildDeclaration({});
  if (operation === 'x402.core.identifier-entry')
    return PAYMENT_IDENTIFIER.buildPayloadEntry(input.declaration, { providedPaymentId: input.payment_id });
  if (!['x402.buyer.sign', 'x402.buyer.cancel', 'x402.buyer.concurrent-await'].includes(operation))
    throw new Error('Unknown x402 operation');
  const base = new URL(input.base_url);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password)
    throw new Error('x402 requests require the loopback platform');
  const client = await buyer.createInflowClient({ apiKey: input.api_key, baseUrl: base.origin });
  const prepared = await client.prepareInflowPayment(input.requirement, input.context, {
    paymentId: input.payment_id,
    pollIntervalMs: input.poll_interval_ms ?? 1,
    timeoutMs: input.timeout_ms ?? 2000,
  });
  if (operation === 'x402.buyer.cancel') await prepared.cancel();
  if (operation === 'x402.buyer.concurrent-await') {
    const [first, second] = await Promise.all([prepared.awaitPayload(), prepared.awaitPayload()]);
    if (!isDeepStrictEqual(first, second)) throw new Error('Concurrent waits returned different results');
    return first;
  }
  return prepared.awaitPayload();
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
      observation = { error: classify(error) };
    }
    if (!isDeepStrictEqual(before, request.input)) throw new Error('Caller input was mutated');
    return { ...envelope, ...observation };
  } catch (error) {
    return { ...envelope, error: { code: 'ADAPTER_ERROR', message: error.message } };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) process.stdout.write(`${JSON.stringify(await respond(JSON.parse(line)))}\n`);
}
