import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';

import { inflow, MppPaymentCancelledError } from '../../src/index.js';

it('aborts a real HTTP response body and cancels the pending approval', async () => {
  const requests: string[] = [];
  let polling = false;
  let disconnected = false;
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/transactions/mpp') {
      response.end(
        JSON.stringify({
          state: 'pending',
          transactionId: 'transaction',
          approvalId: 'approval',
          retryAfterSeconds: 0,
        }),
      );
    } else if (request.url === '/v1/transactions/transaction/mpp') {
      response.write('{"state":');
      polling = true;
      response.on('close', () => {
        disconnected = true;
      });
    } else if (request.url === '/v1/approvals/approval/cancel') {
      response.writeHead(204).end();
    } else response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  const method = inflow({ apiKey: 'synthetic-key', baseUrl: `http://127.0.0.1:${String(address.port)}` });
  try {
    const payment = method
      .createCredential({
        challenge: {
          id: 'challenge',
          realm: 'seller.test',
          method: 'inflow',
          intent: 'charge',
          request: { amount: '1', currency: 'USDC', recipient: '00000000-0000-0000-0000-000000000001' },
        },
        context: {},
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(polling).toBe(true));
    method.cleanup();
    expect(await payment).toBeInstanceOf(MppPaymentCancelledError);
    await vi.waitFor(() => {
      expect(disconnected).toBe(true);
      expect(requests).toEqual([
        '/v1/transactions/mpp',
        '/v1/transactions/transaction/mpp',
        '/v1/approvals/approval/cancel',
      ]);
    });
  } finally {
    method.cleanup();
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
