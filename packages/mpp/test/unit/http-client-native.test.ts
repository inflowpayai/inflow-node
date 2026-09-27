import { once } from 'node:events';
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
  it.each([301, 302, 303, 307, 308])(
    'does not forward credentials or a POST body through a %i redirect',
    async (status) => {
      let destinationRequests = 0;
      const destination = await listen((_request, response) => {
        destinationRequests++;
        response.end('{}');
      });
      const baseUrl = await listen((request, response) => {
        expect(request.headers['x-api-key']).toBe('synthetic-key');
        response.writeHead(status, { location: destination });
        response.end();
      });
      const client = new InflowHttpClient({ apiKey: 'synthetic-key', baseUrl });
      await expect(client.post('/create', { secret: 'synthetic-body' })).rejects.toMatchObject({
        httpStatus: status,
        headers: { location: destination },
      });
      expect(destinationRequests).toBe(0);
    },
  );

  it.each(['headers', 'body'])('preserves custom cancellation while waiting for %s without retrying', async (phase) => {
    const controller = new AbortController();
    let requests = 0;
    const baseUrl = await listen((_request, response) => {
      requests++;
      if (phase === 'body') {
        response.writeHead(200);
        response.write('{');
      }
      if (phase === 'headers') controller.abort(new Error('caller cancelled'));
    });
    const client = new InflowHttpClient({
      baseUrl,
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init);
        if (phase === 'body') controller.abort(new Error('caller cancelled'));
        return response;
      },
    });
    await expect(client.get('/cancel', { signal: controller.signal })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: '/cancel: network error — caller cancelled',
    });
    expect(requests).toBe(1);
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
