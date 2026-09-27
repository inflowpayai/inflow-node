import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createInflowClient, X402ApprovalTimeoutError } from '../../src/index.js';
import { replayWithPayment, sellerProbe } from '../../src/probe/index.js';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: Server): Promise<void> {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

it('returns redirects without forwarding credentials or a payment to another origin', async () => {
  let forwarded = 0;
  const destination = createServer((_request, response) => {
    forwarded++;
    response.end('unexpected');
  });
  const destinationUrl = await listen(destination);
  const source = createServer((_request, response) => {
    response.writeHead(307, { Location: destinationUrl }).end('redirect');
  });
  const sourceUrl = await listen(source);
  try {
    const options = { method: 'POST', headers: { 'X-API-KEY': 'synthetic-key' }, data: 'private body' };
    const probe = await sellerProbe(sourceUrl, options);
    const paid = await replayWithPayment(sourceUrl, { ...options, paymentSignature: 'synthetic-payment' });
    for (const result of [probe, paid]) {
      expect(result.status).toBe(307);
      expect(result.headers.get('location')).toBe(destinationUrl);
      expect(new TextDecoder().decode(result.bytes)).toBe('redirect');
    }
    expect(forwarded).toBe(0);
  } finally {
    await close(source);
    await close(destination);
  }
});

it('interrupts a real polling response body at the deadline without cancelling the two-phase approval', async () => {
  let disconnected = false;
  const paths: string[] = [];
  const requirement = {
    scheme: 'balance',
    network: 'inflow:1',
    asset: '',
    amount: '1',
    payTo: 'seller',
    maxTimeoutSeconds: 300,
    extra: {},
  };
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/transactions/x402-supported') response.end(JSON.stringify({ kinds: [requirement] }));
    else if (request.url === '/v1/transactions/x402')
      response.end(JSON.stringify({ approvalId: 'approval', transactionId: 'transaction', approvalStatus: 'PENDING' }));
    else if (request.url === '/v1/transactions/transaction/x402') {
      response.write('{"status":');
      response.on('close', () => {
        disconnected = true;
      });
    } else response.writeHead(404).end();
  });
  const baseUrl = await listen(server);
  try {
    const client = await createInflowClient({ apiKey: 'synthetic-key', baseUrl });
    const payment = await client.prepareInflowPayment(requirement, {
      resource: { url: 'https://seller.example' },
      x402Version: 2,
    });
    await expect(payment.awaitPayload({ timeoutMs: 100 })).rejects.toBeInstanceOf(X402ApprovalTimeoutError);
    await vi.waitFor(() => expect(disconnected).toBe(true));
    expect(paths).toEqual([
      '/v1/transactions/x402-supported',
      '/v1/transactions/x402',
      '/v1/transactions/transaction/x402',
    ]);
  } finally {
    await close(server);
  }
});
