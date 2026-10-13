import { Buffer } from 'node:buffer';

import { CONTRACTS } from '@inflowpayai/x402';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createInflowClient, X402AdapterRoutingError } from '../../src/index.js';

const baseUrl = 'https://api.inflowpay.ai';
const server = setupServer();
const buyer = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
const networks = ['eip155:5042', 'eip155:5042002', 'eip155:143', 'eip155:10143'] as const;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function requirement(network: (typeof networks)[number]): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://seller.example/report' },
    accepts: [
      {
        scheme: 'exact',
        network,
        asset:
          network === 'eip155:143'
            ? '0x754704bc059f8c67012fed69bc8a327a5aafb603'
            : network === 'eip155:10143'
              ? '0x534b2f3a21130d7a60830c2df862319e593943a3'
              : '0x3600000000000000000000000000000000000000',
        amount: '10000',
        payTo: '0x2222222222222222222222222222222222222222',
        maxTimeoutSeconds: 300,
        extra: { assetName: 'USDC', assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
      },
    ],
  };
}

describe('Arc and Monad buyer routing', () => {
  it.each(networks)(
    'forwards %s exact requirements to the managed signer without changing metadata',
    async (network) => {
      const required = requirement(network);
      const accept = required.accepts[0];
      if (accept === undefined) throw new Error('Missing payment requirements');
      const original = structuredClone(required);
      const signed = {
        x402Version: 2,
        accepted: accept,
        payload: {
          authorization: {
            from: buyer.address,
            to: accept.payTo,
            value: accept.amount,
            validAfter: '0',
            validBefore: '1900000000',
            nonce: `0x${'01'.repeat(32)}`,
          },
          signature: `0x${'11'.repeat(64)}1b`,
        },
      };
      let posted: unknown;
      server.use(
        http.get(`${baseUrl}/v1/transactions/x402-supported`, () =>
          HttpResponse.json({ kinds: [{ x402Version: 2, scheme: 'exact', network }] }),
        ),
        http.post(`${baseUrl}/v1/transactions/x402`, async ({ request }) => {
          posted = await request.json();
          return HttpResponse.json({
            transactionId: 'transaction',
            approvalId: 'approval',
            approvalStatus: 'APPROVED',
          });
        }),
        http.get(`${baseUrl}/v1/transactions/transaction/x402`, () =>
          HttpResponse.json({
            status: 'SETTLED',
            paymentPayload: signed,
            encodedPayload: Buffer.from(JSON.stringify(signed)).toString('base64'),
          }),
        ),
      );
      const client = await createInflowClient({ apiKey: 'local-test-key' });
      expect(await client.selectInflowRequirement(required)).toEqual(accept);
      expect(
        await client.selectInflowRequirement({ ...required, accepts: [{ ...accept, network: 'eip155:8453' }] }),
      ).toBeNull();
      expect(await client.createPaymentPayload(required)).toEqual(signed);
      expect(posted).toEqual({ accept, resource: required.resource, x402Version: 2 });
      expect(required).toEqual(original);
    },
  );

  it.each(networks)('keeps %s Permit2 out of managed signing and delegates to the external buyer', async (network) => {
    const required = requirement(network);
    const accept = required.accepts[0];
    if (accept === undefined) throw new Error('Missing payment requirements');
    accept.extra = { ...accept.extra, assetTransferMethod: 'permit2', permit2Proxy: CONTRACTS.PERMIT2_PROXY };
    server.use(
      http.get(`${baseUrl}/v1/transactions/x402-supported`, () =>
        HttpResponse.json({ kinds: [{ x402Version: 2, scheme: 'exact', network }] }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'local-test-key' });
    expect(await client.selectInflowRequirement(required)).toBeNull();
    await expect(client.prepareInflowPayment(accept, required)).rejects.toBeInstanceOf(X402AdapterRoutingError);
    client.setSpendControls({ allowedAssets: [{ network, asset: accept.asset, maxAmountPerPayment: '10000' }] });
    registerExactEvmScheme(client, { signer: buyer, networks: [network] });
    const payment = await client.createPaymentPayload(required);
    expect(payment.payload).toHaveProperty('permit2Authorization');
    expect(payment.payload).not.toHaveProperty('authorization');
    expect(payment.accepted).toEqual(accept);
  });
});
