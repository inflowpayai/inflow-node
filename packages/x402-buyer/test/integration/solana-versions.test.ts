import {
  createKeyPairSignerFromPrivateKeyBytes,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  verifySignature,
} from '@solana/kit';
import type { PaymentRequired } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createInflowClient } from '../../src/index.js';

const network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const rpcUrl = 'https://solana.example';
const service = setupServer();
beforeAll(() => service.listen({ onUnhandledRequest: 'error' }));
afterEach(() => service.resetHandlers());
afterAll(() => service.close());

async function setup(advertised: unknown, supported?: readonly (0 | 1)[]) {
  const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(1));
  const feePayer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(2));
  const signTransactions = vi.fn(signer.signTransactions);
  const rpc = vi.fn(async (request: Request) => {
    const body = (await request.json()) as { id: string; method: string; params: unknown[] };
    expect(body.method).toBe('getAccountInfo');
    expect(body.params[0]).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    // SPL Mint's binary layout: decimals at byte 44, initialized at byte 45.
    const mint = Buffer.alloc(82);
    mint[44] = 6;
    mint[45] = 1;
    return HttpResponse.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        context: { slot: 100 },
        value: {
          data: [mint.toString('base64'), 'base64'],
          executable: false,
          lamports: 1000000,
          owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          rentEpoch: 0,
          space: 82,
        },
      },
    });
  });
  service.use(
    http.get('https://api.inflowpay.ai/v1/transactions/x402-supported', () => HttpResponse.json({ kinds: [] })),
    http.post(rpcUrl, ({ request }) => rpc(request)),
  );
  const client = await createInflowClient({ apiKey: 'synthetic' });
  client.register(
    network,
    new ExactSvmScheme(
      { ...signer, signTransactions },
      { rpcUrl, ...(supported === undefined ? {} : { transactionVersions: supported }) },
    ),
  );
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: 'https://seller.example/report', description: 'Report', mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network,
        amount: '10000',
        asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        payTo: feePayer.address,
        maxTimeoutSeconds: 60,
        extra: {
          feePayer: feePayer.address,
          recentBlockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: '200',
          ...(advertised === undefined ? {} : { transactionVersions: advertised }),
        },
      },
    ],
  };
  return { client, required, signer, signTransactions, feePayer, rpc };
}

describe('external Solana signing through InflowClient', () => {
  it.each([
    { advertised: undefined, supported: undefined, expected: 0 },
    { advertised: [0], supported: undefined, expected: 0 },
    { advertised: [1], supported: undefined, expected: 1 },
    { advertised: [0, 1], supported: undefined, expected: 1 },
    { advertised: [0, 1], supported: [0] as const, expected: 0 },
  ])(
    'builds and signs version $expected for $advertised with client limit $supported',
    async ({ advertised, supported, expected }) => {
      const { client, required, signer, signTransactions, feePayer, rpc } = await setup(advertised, supported);
      const original = structuredClone(required);
      const payload = await client.createPaymentPayload(required);
      expect(payload.accepted).toEqual(required.accepts[0]);
      expect(required).toEqual(original);
      const wire = payload.payload['transaction'];
      if (typeof wire !== 'string') throw new Error('Missing signed transaction');
      const transaction = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
      expect(getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).version).toBe(expected);
      const signature = transaction.signatures[signer.address];
      if (signature == null) throw new Error('Missing buyer signature');
      expect(
        await verifySignature(await getPublicKeyFromAddress(signer.address), signature, transaction.messageBytes),
      ).toBe(true);
      expect(transaction.signatures[feePayer.address]).toBeNull();
      expect(signTransactions).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { advertised: [1], supported: [0] as const },
    { advertised: [], supported: undefined },
    { advertised: [2], supported: undefined },
    { advertised: ['1'], supported: undefined },
    { advertised: '1', supported: undefined },
  ])('rejects incompatible or malformed $advertised before signing or RPC', async ({ advertised, supported }) => {
    const { client, required, signTransactions, rpc } = await setup(advertised, supported);
    await expect(client.createPaymentPayload(required)).rejects.toThrow(/transaction.version/i);
    expect(signTransactions).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
