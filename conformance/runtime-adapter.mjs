import { isDeepStrictEqual } from 'node:util';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import * as mpp from '../packages/mpp/dist/index.js';
import * as x402 from '../packages/x402/dist/index.js';

export async function execute(operation, input) {
  const sdk = { mpp, x402 }[input.product];
  if (!sdk) throw new Error('Unknown runtime product');
  if (operation === 'runtime.environment') {
    return {
      resolved: sdk.resolveBaseUrl(input.options),
      client: new sdk.InflowHttpClient(input.options).baseUrl,
    };
  }
  if (operation !== 'runtime.requests') throw new Error('Unknown runtime operation');
  const base = new URL(input.base_url);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) {
    throw new Error('Runtime requests require the loopback platform');
  }
  let tokenIndex = 0;
  const client = new sdk.InflowHttpClient({
    baseUrl: base.origin,
    ...(input.api_key === undefined ? {} : { apiKey: input.api_key }),
    ...(input.tokens === undefined ? {} : { getAccessToken: async () => input.tokens[tokenIndex++] }),
  });
  const outcomes = [];
  for (const call of input.calls) {
    if (!['GET', 'POST'].includes(call.method)) throw new Error('Unsupported request method');
    if (!call.path.startsWith('/') || call.path.startsWith('//')) throw new Error('Expected a relative API path');
    const controller = new AbortController();
    const timer =
      call.abort_after_ms === undefined ? undefined : setTimeout(() => controller.abort(), call.abort_after_ms);
    try {
      const options = { ...call.options, signal: controller.signal };
      const value =
        call.method === 'POST'
          ? await client.post(call.path, call.body, options)
          : await client.get(call.path, options);
      outcomes.push({ value: value === undefined ? null : value });
    } catch (error) {
      if (!(error instanceof sdk.InflowApiError)) throw error;
      outcomes.push({
        code: error.code,
        http_status: error.httpStatus,
        ...(error.httpStatus === 0 ? {} : { message: error.message }),
        endpoint: error.endpoint,
        request_id: error.requestId ?? null,
        sensitive_headers: Object.keys(error.headers ?? {}).filter((name) =>
          ['authorization', 'cookie', 'set-cookie', 'x-api-key'].includes(name.toLowerCase()),
        ),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return { outcomes, token_calls: tokenIndex };
}

export async function respond(request) {
  const envelope = {
    adapter_version: '1',
    sequence: request.sequence,
    case_id: request.case_id,
  };
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
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    process.stdout.write(`${JSON.stringify(await respond(JSON.parse(line)))}\n`);
  }
}
