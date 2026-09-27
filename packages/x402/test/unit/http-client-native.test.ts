import { getEventListeners, once } from 'node:events';
import { createServer, type RequestListener, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { InflowHttpClient } from '../../src/index.js';

const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

describe('native HTTP timeout and cancellation', () => {
  it.each(['api-key', 'bearer', 'anonymous'])(
    'does not forward %s credentials or the body to a redirect destination',
    async (auth) => {
      let destinationRequests = 0;
      const destination = await listen((_request, response) => {
        destinationRequests++;
        response.end('{}');
      });
      let sourceRequests = 0;
      let receivedKey: string | string[] | undefined;
      let receivedAuthorization: string | undefined;
      const baseUrl = await listen((request, response) => {
        sourceRequests++;
        receivedKey = request.headers['x-api-key'];
        receivedAuthorization = request.headers.authorization;
        response.writeHead(307, { location: `${destination}/forwarded` });
        response.end('redirect');
      });
      const client = new InflowHttpClient({
        baseUrl,
        ...(auth === 'api-key' ? { apiKey: 'synthetic-key' } : {}),
        ...(auth === 'bearer' ? { getAccessToken: () => Promise.resolve('synthetic-token') } : {}),
      });
      await expect(client.post('/pay', { signature: 'synthetic-signature' })).rejects.toMatchObject({
        httpStatus: 307,
        body: 'redirect',
        headers: { location: `${destination}/forwarded` },
      });
      expect(receivedKey).toBe(auth === 'api-key' ? 'synthetic-key' : undefined);
      expect(receivedAuthorization).toBe(auth === 'bearer' ? 'Bearer synthetic-token' : undefined);
      expect(sourceRequests).toBe(1);
      expect(destinationRequests).toBe(0);
    },
  );

  it('does not retry a native fetch cancelled with an ordinary Error', async () => {
    const controller = new AbortController();
    let requests = 0;
    const baseUrl = await listen((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      controller.abort(new Error('stopped'));
    });
    await expect(
      new InflowHttpClient({ baseUrl }).get('/cancel', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: '/cancel: network error — stopped' });
    expect(requests).toBe(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['headers', 'body'])('classifies a timeout waiting for %s', async (phase) => {
    let requests = 0;
    const baseUrl = await listen((_request, response) => {
      requests++;
      if (phase === 'body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"pending":');
      }
    });
    const client = new InflowHttpClient({ baseUrl });
    await expect(client.get('/slow', { timeoutMs: 1000, retries: 0 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      httpStatus: 0,
      endpoint: '/slow',
      message: '/slow: network error — request timed out',
    });
    expect(requests).toBe(1);
  });

  it('retries a timeout within the requested budget and returns the subsequent response', async () => {
    let requests = 0;
    const baseUrl = await listen((_request, response) => {
      if (++requests === 2) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      }
    });
    const client = new InflowHttpClient({ baseUrl });
    await expect(client.get('/retry', { timeoutMs: 1000, retries: 1 })).resolves.toEqual({ ok: true });
    expect(requests).toBe(2);
  });

  it('stops after exhausting the timeout retry budget', async () => {
    let requests = 0;
    const baseUrl = await listen(() => {
      requests++;
    });
    const client = new InflowHttpClient({ baseUrl });
    await expect(client.get('/slow', { timeoutMs: 1000, retries: 1 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(requests).toBe(2);
  });

  it('keeps parallel timeout, successful request, and caller cancellation independent', async () => {
    const controller = new AbortController();
    const requests: string[] = [];
    const baseUrl = await listen((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/cancel') controller.abort();
      if (request.url === '/ok') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      }
    });
    const client = new InflowHttpClient({ baseUrl });
    await Promise.all([
      expect(client.get('/slow', { timeoutMs: 1000, retries: 0 })).rejects.toMatchObject({ code: 'TIMEOUT' }),
      expect(client.get('/ok', { timeoutMs: 3000 })).resolves.toEqual({ ok: true }),
      expect(client.get('/cancel', { timeoutMs: 3000, signal: controller.signal })).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        httpStatus: 0,
      }),
    ]);
    expect(requests.sort()).toEqual(['/cancel', '/ok', '/slow']);
  });

  it('preserves ordinary network failures', async () => {
    const baseUrl = await listen((request) => request.socket.destroy());
    const client = new InflowHttpClient({ baseUrl });
    await expect(client.get('/disconnect', { retries: 0 })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      httpStatus: 0,
    });
  });
});
