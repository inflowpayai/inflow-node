import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { InflowHttpClient } from '../../src/http-client.js';

describe('API key providers', () => {
  it('resolves a fresh key for each HTTP attempt and later request', async () => {
    const received: Array<string | string[] | undefined> = [];
    const server = createServer((request, response) => {
      received.push(request.headers['x-api-key']);
      expect(request.headers.authorization).toBeUndefined();
      response.writeHead(received.length === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Missing listener');
      let calls = 0;
      const client = new InflowHttpClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: () => Promise.resolve(`key-${++calls}`),
      });
      expect(calls).toBe(0);
      await client.get('/example', { retries: 1 });
      await client.get('/example');
      expect(received).toEqual(['key-1', 'key-2', 'key-3']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it.each(['', ' ', 'line\nvalue', 'é', 7, null])('rejects an invalid provider result: %s', async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    // Exercise an untyped provider at the public boundary.
    const apiKey = () => Promise.resolve(value as string);
    const client = new InflowHttpClient({ apiKey, fetch });
    await expect(client.get('/example')).rejects.toThrow('API key provider');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('propagates provider failure without retrying or fetching', async () => {
    const error = new Error('provider unavailable');
    const apiKey = vi.fn(() => Promise.reject(error));
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(new InflowHttpClient({ apiKey, fetch }).get('/example')).rejects.toBe(error);
    expect(apiKey).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps concurrent calls independent', async () => {
    let calls = 0;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((_url, init) => Promise.resolve(Response.json(new Headers(init?.headers).get('X-API-KEY'))));
    const client = new InflowHttpClient({ apiKey: () => Promise.resolve(`key-${++calls}`), fetch });
    expect(await Promise.all([client.get('/one'), client.get('/two')])).toEqual(['key-1', 'key-2']);
  });

  it('does not send after cancellation during provider resolution', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const apiKey = vi.fn(() => {
      controller.abort();
      return Promise.resolve('key');
    });
    const client = new InflowHttpClient({ apiKey, fetch });
    await expect(client.get('/example', { signal: controller.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.get('/example', { signal: controller.signal })).rejects.toThrow();
    expect(apiKey).toHaveBeenCalledTimes(1);
  });

  it('rejects combining API key and bearer providers', () => {
    // Exercise conflicting options from an untyped consumer.
    expect(
      () =>
        new InflowHttpClient({
          apiKey: () => Promise.resolve('key'),
          getAccessToken: () => Promise.resolve('token'),
        } as never),
    ).toThrow('mutually exclusive');
  });
});
