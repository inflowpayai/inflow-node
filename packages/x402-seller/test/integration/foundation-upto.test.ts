import { once } from 'node:events';

import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { isUptoPermit2Payload, x402UptoPermit2ProxyAddress } from '@x402/evm';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { paymentMiddlewareFromConfig, setSettlementOverrides } from '@x402/express';
import express from 'express';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '../../src/index.js';
import { UPTO_CONFIG, UPTO_KIND } from '../fixtures/upto-config.js';

interface FacilitatorRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

const buyer = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');

async function harness(amount: string | undefined, allowanceRequired = false, handlerStatus = 200) {
  const calls: Array<{ operation: string; body: FacilitatorRequest }> = [];
  const events: string[] = [];
  const app = express();
  app.use(express.json());
  app.get('/v1/x402/config', (_request, response) => response.json(UPTO_CONFIG));
  app.get('/v1/x402/supported', (_request, response) =>
    response.json({ kinds: [UPTO_KIND], extensions: [], signers: {} }),
  );
  app.post<Record<string, never>, unknown, FacilitatorRequest>('/v1/x402/verify', (request, response) => {
    events.push('verify');
    calls.push({ operation: 'verify', body: request.body });
    response
      .status(allowanceRequired ? 412 : 200)
      .json(
        allowanceRequired
          ? { isValid: false, invalidReason: 'permit2_allowance_required', payer: buyer.address }
          : { isValid: true, payer: buyer.address },
      );
  });
  app.post<Record<string, never>, unknown, FacilitatorRequest>('/v1/x402/settle', (request, response) => {
    events.push('settle');
    calls.push({ operation: 'settle', body: request.body });
    response.json({
      success: true,
      transaction: '0xSettled',
      network: request.body.paymentRequirements.network,
      payer: buyer.address,
      amount: request.body.paymentRequirements.amount,
    });
  });

  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a local listener');
  const baseUrl = `http://127.0.0.1:${address.port.toString()}`;
  const options = { environment: 'sandbox' as const, apiKey: 'local-test-key', baseUrl };
  const seller = await createInflowSellerClient(options);
  const schemes = ['upto'];
  app.use(
    paymentMiddlewareFromConfig(
      { 'GET /metered': { accepts: await inflowAccepts(seller, { price: '$0.10', schemes }) } },
      [createInflowFacilitator(options)],
      await inflowSchemeRegistrations(seller, { schemes }),
    ),
  );
  app.get('/metered', (_request, response) => {
    events.push('handler');
    if (amount !== undefined) setSettlementOverrides(response, { amount });
    response.status(handlerStatus).json({ result: 'metered response' });
  });

  return {
    calls,
    events,
    url: `${baseUrl}/metered`,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe('external foundation buyer through the InFlow seller transport', () => {
  it.each(['40000', '100000', '0', undefined])(
    'preserves the signed ceiling and sends actual settlement %s',
    async (amount) => {
      const server = await harness(amount);
      try {
        const challenge = await fetch(server.url);
        expect(challenge.status).toBe(402);
        const requiredHeader = challenge.headers.get('payment-required');
        if (requiredHeader === null) throw new Error('Missing payment challenge');
        const required = decodePaymentRequiredHeader(requiredHeader);
        expect(required.accepts[0]).toMatchObject({ amount: '100000', extra: UPTO_KIND.extra });

        const client = new x402Client().register('eip155:8453', new UptoEvmScheme(buyer));
        const payment = await client.createPaymentPayload(required);
        if (!isUptoPermit2Payload(payment.payload)) throw new Error('Expected the upstream Permit2 payload');
        expect(payment.payload.permit2Authorization).toMatchObject({
          permitted: { amount: '100000' },
          spender: x402UptoPermit2ProxyAddress,
          witness: { facilitator: UPTO_KIND.extra?.['facilitatorAddress'] },
        });
        expect(payment.payload.signature).toMatch(/^0x[\da-f]{130}$/u);
        const paid = await fetch(server.url, {
          headers: { 'payment-signature': encodePaymentSignatureHeader(payment) },
        });
        expect(paid.status).toBe(200);
        expect(await paid.json()).toEqual({ result: 'metered response' });
        expect(paid.headers.get('settlement-overrides')).toBeNull();
        const receipt = paid.headers.get('payment-response');
        if (receipt === null) throw new Error('Missing payment receipt');
        expect(decodePaymentResponseHeader(receipt)).toMatchObject({ success: true, amount: amount ?? '100000' });
        expect(server.events).toEqual(['verify', 'handler', 'settle']);
        expect(server.calls.map((call) => call.body.paymentRequirements.amount)).toEqual([
          '100000',
          amount ?? '100000',
        ]);
        for (const call of server.calls) {
          expect(call.body.paymentPayload.accepted.amount).toBe('100000');
          expect(call.body.paymentPayload.payload).toEqual(payment.payload);
        }
      } finally {
        await server.close();
      }
    },
  );

  it.each([400, 500])('does not settle a handler %s response when the amount override is omitted', async (status) => {
    const server = await harness(undefined, false, status);
    try {
      const challenge = await fetch(server.url);
      expect(challenge.status).toBe(402);
      const requiredHeader = challenge.headers.get('payment-required');
      if (requiredHeader === null) throw new Error('Missing payment challenge');
      const client = new x402Client().register('eip155:8453', new UptoEvmScheme(buyer));
      const payment = await client.createPaymentPayload(decodePaymentRequiredHeader(requiredHeader));
      const response = await fetch(server.url, {
        headers: { 'payment-signature': encodePaymentSignatureHeader(payment) },
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ result: 'metered response' });
      expect(response.headers.get('payment-response')).toBeNull();
      expect(response.headers.get('settlement-overrides')).toBeNull();
      expect(server.events).toEqual(['verify', 'handler']);
      expect(server.calls.map((call) => call.operation)).toEqual(['verify']);
    } finally {
      await server.close();
    }
  });

  it('returns the real adapter allowance response without running the handler or settling', async () => {
    const server = await harness('40000', true);
    try {
      const challenge = await fetch(server.url);
      const requiredHeader = challenge.headers.get('payment-required');
      if (requiredHeader === null) throw new Error('Missing payment challenge');
      const client = new x402Client().register('eip155:8453', new UptoEvmScheme(buyer));
      const payment = await client.createPaymentPayload(decodePaymentRequiredHeader(requiredHeader));
      const response = await fetch(server.url, {
        headers: { 'payment-signature': encodePaymentSignatureHeader(payment) },
      });
      expect(response.status).toBe(412);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(server.events).toEqual(['verify']);
    } finally {
      await server.close();
    }
  });
});
