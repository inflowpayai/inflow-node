import { createPublicKey } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  createTapVerifier,
  createTapMiddleware,
  MemoryTapReplayStore,
  VisaTapKeyResolver,
  TapVerificationError,
} from '../packages/tap-seller/dist/index.js';

export async function execute(operation, input) {
  if (operation !== 'tap.seller.verify') throw new Error(`Unsupported operation: ${operation}`);
  let now = 0;
  const clock = () => now;
  const resolverFailure = new Error('Synthetic resolver failure');
  const storeFailure = new Error('Synthetic replay-store failure');
  const key = createPublicKey({ key: input.key, format: 'jwk' });
  const keyResolver =
    input.resolver === 'http'
      ? new VisaTapKeyResolver({
          url: new URL('/keys', input.base_url),
          clock,
          cacheTtlMs: input.cache_ttl_ms,
          cacheMaxAgeMs: input.cache_max_age_ms,
        })
      : {
          async resolve(keyid, algorithm) {
            if (input.resolver_failure) throw resolverFailure;
            if (input.resolver_completion_ms !== undefined) now = input.resolver_completion_ms;
            return keyid === input.key.kid && algorithm === 'ed25519' ? { keyid, algorithm, key } : undefined;
          },
        };
  const memory = new MemoryTapReplayStore(clock);
  let claim_calls = 0;
  let handler_calls = 0;
  const middleware = createTapMiddleware(
    createTapVerifier({
      clock,
      keyResolver,
      replayStore: {
        claim(keyid, nonce, expires) {
          claim_calls++;
          if (input.store_failure) throw storeFailure;
          return memory.claim(keyid, nonce, expires);
        },
      },
    }),
  );
  const steps = [];
  for (const step of input.steps) {
    now = step.now_ms;
    const accepted = [];
    const rejected = [];
    await Promise.all(
      step.requests.map(async (request) => {
        const supplied = {
          method: request.method,
          url: request.url,
          headers: request.headers,
          ...(request.body_base64 === undefined
            ? {}
            : { body: Uint8Array.from(Buffer.from(request.body_base64, 'base64')) }),
        };
        const before = structuredClone(supplied);
        try {
          await middleware(supplied, (facts) => {
            handler_calls++;
            accepted.push(facts);
          });
        } catch (error) {
          if (error instanceof TapVerificationError) rejected.push(error.code);
          else if (error === resolverFailure) rejected.push('CUSTOM_RESOLVER_FAILED');
          else if (error === storeFailure) rejected.push('CUSTOM_STORE_FAILED');
          else throw error;
        } finally {
          if (!isDeepStrictEqual(before, supplied)) throw new Error('Caller request was mutated');
        }
      }),
    );
    rejected.sort();
    steps.push({ accepted, rejected });
  }
  return { steps, handler_calls, claim_calls };
}

export async function respond(request) {
  const envelope = { adapter_version: '1', sequence: request.sequence, case_id: request.case_id };
  try {
    if (request.adapter_version !== '1') throw new Error('Unsupported adapter version');
    const before = structuredClone(request.input);
    const result = await execute(request.operation, request.input);
    if (!isDeepStrictEqual(before, request.input)) throw new Error('Caller input was mutated');
    return { ...envelope, result };
  } catch (error) {
    return { ...envelope, error: { code: 'ADAPTER_ERROR', message: error.message } };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity }))
    process.stdout.write(`${JSON.stringify(await respond(JSON.parse(line)))}\n`);
}
