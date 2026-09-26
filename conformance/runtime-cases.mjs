const failure = (status, code, message, endpoint, requestId = null) => ({
  code,
  http_status: status,
  ...(status === 0 ? {} : { message }),
  endpoint,
  request_id: requestId,
  sensitive_headers: [],
});

export function runtimeCases(scenarios) {
  const cases = [];
  for (const product of ['mpp', 'x402']) {
    const add = (id, input, outcomes, platform) =>
      cases.push({
        id: `${product}.${id}`,
        suite: 'runtime',
        operation: 'runtime.requests',
        input: { product, ...input },
        ...(platform ? { platform } : {}),
        expect: { result: { outcomes, token_calls: input.tokens?.length ?? 0 } },
      });
    for (const [id, platform] of Object.entries(scenarios)) {
      const headers = platform.exchanges[0].request.headers;
      const token = headers.authorization?.slice('Bearer '.length);
      const input = {
        ...(headers['x-api-key'] ? { api_key: headers['x-api-key'] } : {}),
        ...(token ? { tokens: platform.exchanges.map(() => token) } : {}),
        calls: platform.exchanges.map(({ request }) => ({
          method: request.method,
          path: request.path,
          options: { retries: 0 },
        })),
      };
      const outcomes = platform.exchanges.map(({ request, response }) => {
        if (response.status < 300) return { value: response.json ?? null };
        const entry = response.json?.errors[0];
        return failure(
          response.status,
          entry?.code ?? 'UNEXPECTED_ERROR',
          entry?.message ?? 'request failed',
          request.path,
        );
      });
      add(id, input, outcomes, platform);
    }
    for (const [id, options, expected] of [
      ['default', {}, 'https://api.inflowpay.ai'],
      ['production', { environment: 'production' }, 'https://api.inflowpay.ai'],
      ['sandbox', { environment: 'sandbox' }, 'https://sandbox.inflowpay.ai'],
      ['override', { environment: 'sandbox', baseUrl: 'http://127.0.0.1:1234///' }, 'http://127.0.0.1:1234'],
    ]) {
      cases.push({
        id: `${product}.environment.${id}`,
        suite: 'runtime',
        operation: 'runtime.environment',
        input: { product, options },
        expect: { result: { resolved: expected, client: expected } },
      });
    }
    const path = '/v1/runtime-test';
    const call = { method: 'GET', path };
    const exchange = (response, headers = {}) => ({ request: { method: 'GET', path, headers }, response });
    const ok = { status: 200, json: { ok: true } };
    for (const status of [429, 502, 503, 504]) {
      add(`retry.${status}`, { calls: [call] }, [{ value: { ok: true } }], {
        exchanges: [exchange({ status }), exchange(ok)],
      });
    }
    for (const status of [400, 401, 403, 404, 409, 412, 500]) {
      add(`no-retry.${status}`, { calls: [call] }, [failure(status, 'UNEXPECTED_ERROR', 'request failed', path)], {
        exchanges: [exchange({ status })],
      });
    }
    add(
      'retry.limit',
      { calls: [{ ...call, options: { retries: 99 } }] },
      [failure(503, 'UNEXPECTED_ERROR', 'request failed', path)],
      {
        exchanges: Array.from({ length: 4 }, () => exchange({ status: 503 })),
      },
    );
    add(
      'retry.disabled',
      { calls: [{ method: 'POST', path, body: { amount: '100' }, options: { retries: 0 } }] },
      [failure(503, 'UNEXPECTED_ERROR', 'request failed', path)],
      {
        exchanges: [{ request: { method: 'POST', path, json: { amount: '100' } }, response: { status: 503 } }],
      },
    );
    add('retry.network', { calls: [call] }, [{ value: { ok: true } }], {
      exchanges: [exchange({ status: 200, disconnect: true }), exchange(ok)],
    });
    add(
      'auth.rotation',
      { tokens: ['test-only-first', 'test-only-second'], calls: [call] },
      [{ value: { ok: true } }],
      {
        exchanges: [
          exchange({ status: 503 }, { authorization: 'Bearer test-only-first' }),
          exchange(ok, { authorization: 'Bearer test-only-second' }),
        ],
      },
    );
    add('http.json', { calls: [call] }, [{ value: { count: 2 } }], {
      exchanges: [exchange({ status: 200, json: { count: 2 } })],
    });
    add('http.text', { calls: [call] }, [{ value: 'accepted' }], {
      exchanges: [exchange({ status: 200, text: 'accepted' })],
    });
    add('http.malformed-json', { calls: [call] }, [{ value: '{bad' }], {
      exchanges: [exchange({ status: 200, text: '{bad', headers: { 'content-type': 'application/json' } })],
    });
    add(
      'error.headers',
      { calls: [call] },
      [failure(400, 'PARAMETER_INVALID', 'Invalid value.', path, 'test-request')],
      {
        exchanges: [
          exchange({
            status: 400,
            json: { errors: [{ code: 'PARAMETER_INVALID', message: 'Invalid value.' }] },
            headers: {
              'x-request-id': 'test-request',
              authorization: 'test-only-secret',
              'x-api-key': 'test-only-key',
              cookie: 'test-only-cookie',
              'set-cookie': 'test-only-cookie',
            },
          }),
        ],
      },
    );
    add(
      'http.timeout',
      { calls: [{ ...call, options: { retries: 0, timeoutMs: 500 } }] },
      [failure(0, 'TIMEOUT', undefined, path)],
      { exchanges: [exchange({ ...ok, delay_ms: 1000 })] },
    );
    add('http.abort', { calls: [{ ...call, abort_after_ms: 200 }] }, [failure(0, 'NETWORK_ERROR', undefined, path)], {
      exchanges: [exchange({ ...ok, delay_ms: 1000 })],
    });
  }
  return { cases };
}
