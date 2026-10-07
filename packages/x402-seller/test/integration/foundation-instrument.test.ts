import { once } from 'node:events';

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { paymentMiddlewareFromConfig } from '@x402/express';
import express from 'express';
import { describe, expect, it } from 'vitest';

import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '../../src/index.js';

const sellerId = '00000000-0000-0000-0000-000000000001';
const transactionId = '00000000-0000-0000-0000-000000000002';
const kind = { scheme: 'instrument', network: 'inflow:1', x402Version: 2 };

interface PaymentRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

describe('Instrument offers through foundation Express', () => {
  it.each(['success', 'pending'] as const)('preserves USD amounts and handles %s settlement', async (outcome) => {
    const requests: PaymentRequest[] = [];
    const app = express();
    app.use(express.json());
    app.get('/v1/x402/config', (_request, response) =>
      response.json({
        sellerId,
        wallets: [],
        assets: [],
        supported: [kind],
        paymentMethods: [{ scheme: 'instrument', network: 'inflow:1', payTo: sellerId, decimals: 18 }],
      }),
    );
    app.get('/v1/x402/supported', (_request, response) =>
      response.json({ kinds: [kind], extensions: [], signers: {} }),
    );
    app.post<Record<string, never>, unknown, PaymentRequest>('/v1/x402/verify', (request, response) => {
      requests.push(request.body);
      response.json({ isValid: true });
    });
    app.post<Record<string, never>, unknown, PaymentRequest>('/v1/x402/settle', (request, response) => {
      requests.push(request.body);
      if (outcome === 'pending') {
        response.setHeader('Retry-After', '0');
        response.status(409).json({
          success: false,
          errorReason: 'idempotency_pending',
          errorMessage: 'The card payment is awaiting a confirmed outcome.',
        });
      } else {
        response.json({ success: true, network: 'inflow:1', transaction: transactionId });
      }
    });
    const listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    try {
      const address = listener.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a local listener');
      const baseUrl = `http://127.0.0.1:${address.port.toString()}`;
      const options = { environment: 'sandbox' as const, apiKey: 'local-test-key', baseUrl };
      const seller = await createInflowSellerClient(options);
      app.use(
        paymentMiddlewareFromConfig(
          { 'GET /report': { accepts: await inflowAccepts(seller, { price: '$1.00', schemes: ['instrument'] }) } },
          [createInflowFacilitator(options)],
          await inflowSchemeRegistrations(seller, { schemes: ['instrument'] }),
        ),
      );
      app.get('/report', (_request, response) => response.json({ report: 'protected result' }));

      const challenge = await fetch(`${baseUrl}/report`);
      expect(challenge.status).toBe(402);
      const header = challenge.headers.get('payment-required');
      if (header === null) throw new Error('Missing payment challenge');
      const required = decodePaymentRequiredHeader(header);
      expect(required.accepts).toHaveLength(1);
      const accepted = required.accepts[0];
      if (accepted === undefined) throw new Error('Missing payment requirements');
      expect(accepted).toMatchObject({
        scheme: 'instrument',
        network: 'inflow:1',
        asset: 'USD',
        amount: '1000000000000000000',
        payTo: sellerId,
      });
      const paid = await fetch(`${baseUrl}/report`, {
        headers: {
          'payment-signature': encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { transactionId } }),
        },
      });
      expect(requests).toHaveLength(outcome === 'success' ? 2 : 6);
      for (const request of requests) {
        expect(request.paymentRequirements).toEqual(accepted);
        expect(request.paymentPayload.payload).toEqual({ transactionId });
        expect(request.paymentPayload.extensions).toEqual(requests[0]?.paymentPayload.extensions);
      }
      if (outcome === 'success') {
        expect(paid.status).toBe(200);
        expect(await paid.json()).toEqual({ report: 'protected result' });
        const receipt = paid.headers.get('payment-response');
        if (receipt === null) throw new Error('Missing payment receipt');
        expect(decodePaymentResponseHeader(receipt)).toMatchObject({ success: true, transaction: transactionId });
      } else {
        expect(paid.status).not.toBe(200);
        expect(await paid.text()).not.toContain('protected result');
      }
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
