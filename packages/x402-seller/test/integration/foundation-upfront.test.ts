import { EventEmitter, once } from 'node:events';
import { setTimeout } from 'node:timers/promises';

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { paymentMiddlewareFromConfig } from '@x402/express';
import express from 'express';
import { describe, expect, it } from 'vitest';

import { createInflowFacilitator, inflowAccepts, inflowSchemeRegistrations } from '../../src/index.js';
import { SAMPLE_CONFIG } from '../fixtures/config-response.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';

interface PaymentRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

type Outcome = 'success' | 'rejected' | 'pending' | 'pending-success' | 'disconnected';

async function fixture(
  options: {
    flow?: 'authorization' | 'upfront';
    outcome?: Outcome;
    handler?: 'success' | 'error' | 'throw';
    scheme?: 'exact' | 'balance' | 'instrument';
    network?: string;
    currency?: string;
    beforeSettlement?: () => Promise<void>;
  } = {},
) {
  const events: string[] = [];
  const settlements: PaymentRequest[] = [];
  const seller = fakeSellerClient({
    ...SAMPLE_CONFIG,
    paymentMethods: [
      ...SAMPLE_CONFIG.paymentMethods,
      { scheme: 'instrument', network: 'inflow:1', payTo: SAMPLE_CONFIG.sellerId, decimals: 18 },
    ],
  });
  const app = express();
  app.use(express.json());
  app.get('/v1/x402/supported', (_request, response) =>
    response.json({
      kinds: [...SAMPLE_CONFIG.supported, { x402Version: 2, scheme: 'instrument', network: 'inflow:1' }],
      extensions: [],
      signers: {},
    }),
  );
  app.post('/v1/x402/verify', (_request, response) => {
    events.push('verify');
    response.json({ isValid: true });
  });
  app.post<Record<string, never>, unknown, PaymentRequest>('/v1/x402/settle', async (request, response) => {
    events.push('settle');
    settlements.push(request.body);
    await options.beforeSettlement?.();
    if (options.outcome === 'disconnected') {
      request.socket.destroy();
    } else if (options.outcome === 'pending' || (options.outcome === 'pending-success' && settlements.length === 1)) {
      response.setHeader('Retry-After', '0');
      response.status(409).json({ success: false, errorReason: 'idempotency_pending' });
    } else {
      response.json({
        success: options.outcome !== 'rejected',
        ...(options.outcome === 'rejected' ? { errorReason: 'settlement_failed' } : {}),
        network: request.body.paymentRequirements.network,
        transaction: 'fixture-settlement',
      });
    }
  });
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('Expected local listener');
  const origin = `http://127.0.0.1:${address.port.toString()}`;
  const accepts = await inflowAccepts(seller, {
    price: `1 ${options.currency ?? 'USD'}`,
    schemes: [options.scheme ?? 'instrument'],
    ...(options.network === undefined ? {} : { networks: [options.network] }),
    ...(options.flow === undefined ? {} : { paymentFlow: options.flow }),
  });
  app.use(
    paymentMiddlewareFromConfig(
      { 'GET /report': { accepts } },
      [createInflowFacilitator({ environment: 'sandbox', apiKey: 'fixture-key', baseUrl: origin })],
      await inflowSchemeRegistrations(seller),
    ),
  );
  app.get('/report', (_request, response) => {
    events.push('handler');
    if (options.handler === 'throw') throw new Error('report failed');
    response.status(options.handler === 'error' ? 500 : 200).json({ report: 'fixture report' });
  });
  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: error.message });
  });
  return {
    events,
    settlements,
    request: (payment?: string) =>
      fetch(`${origin}/report`, {
        headers: payment === undefined ? {} : { 'payment-signature': payment },
        signal: AbortSignal.timeout(5_000),
      }),
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function challenge(harness: Awaited<ReturnType<typeof fixture>>) {
  const response = await harness.request();
  expect(response.status).toBe(402);
  await response.arrayBuffer();
  const header = response.headers.get('payment-required');
  if (header === null) throw new Error('Missing challenge');
  const accepted = decodePaymentRequiredHeader(header).accepts[0];
  if (accepted === undefined) throw new Error('Missing offer');
  const payment = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: { transactionId: '00000000-0000-0000-0000-000000000002' },
  });
  return { accepted, payment };
}

describe('real Express middleware and InFlow facilitator client upfront lifecycle', () => {
  it.each(['success', 'rejected'] as const)(
    'waits for the settlement response before deciding on %s',
    async (outcome) => {
      const gate = new EventEmitter();
      const released = once(gate, 'released');
      const harness = await fixture({
        flow: 'upfront',
        outcome,
        beforeSettlement: async () => {
          gate.emit('entered');
          await released;
        },
      });
      let pending: Promise<Response> | undefined;
      let responseReceived = false;
      try {
        const { payment } = await challenge(harness);
        const entered = once(gate, 'entered', { signal: AbortSignal.timeout(2_000) });
        pending = harness.request(payment).then((response) => {
          responseReceived = true;
          return response;
        });
        await entered;
        await setTimeout(25);
        expect(harness.events).toEqual(['settle']);
        expect(responseReceived).toBe(false);
        gate.emit('released');
        const response = await pending;
        expect(response.status).toBe(outcome === 'success' ? 200 : 402);
        expect(harness.events).toEqual(outcome === 'success' ? ['settle', 'handler'] : ['settle']);
        expect(harness.settlements).toHaveLength(1);
      } finally {
        gate.emit('released');
        try {
          await (await pending)?.arrayBuffer();
        } finally {
          await harness.close();
        }
      }
    },
  );

  it.each([
    { scheme: 'instrument' as const },
    { scheme: 'balance' as const },
    { scheme: 'exact' as const, network: 'eip155:8453', currency: 'USDC' },
    { scheme: 'exact' as const, network: 'eip155:8453', currency: 'USDT' },
    { scheme: 'exact' as const, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
  ])('settles before execution for $scheme $network $currency', async (offer) => {
    const harness = await fixture({ ...offer, flow: 'upfront' });
    try {
      const { accepted, payment } = await challenge(harness);
      expect(accepted.extra['paymentFlow']).toBe('upfront');
      expect(harness.events).toEqual([]);
      const response = await harness.request(payment);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(harness.events).toEqual(['settle', 'handler']);
      expect(harness.settlements[0]?.paymentRequirements).toEqual(accepted);
      const receipt = response.headers.get('payment-response');
      if (receipt === null) throw new Error('Missing receipt');
      expect(decodePaymentResponseHeader(receipt)).toMatchObject({ success: true, transaction: 'fixture-settlement' });
    } finally {
      await harness.close();
    }
  });

  it.each([undefined, 'authorization'] as const)('preserves %s authorization ordering', async (flow) => {
    const harness = await fixture(flow === undefined ? {} : { flow });
    try {
      const { accepted, payment } = await challenge(harness);
      expect(accepted.extra['paymentFlow']).toBeUndefined();
      await (await harness.request(payment)).arrayBuffer();
      expect(harness.events).toEqual(['verify', 'handler', 'settle']);
    } finally {
      await harness.close();
    }
  });

  it.each(['rejected', 'pending', 'disconnected'] as const)('does not execute on %s settlement', async (outcome) => {
    const harness = await fixture({ flow: 'upfront', outcome });
    try {
      const { payment } = await challenge(harness);
      const response = await harness.request(payment);
      expect(response.status).toBeGreaterThanOrEqual(400);
      await response.arrayBuffer();
      expect(harness.events).not.toContain('handler');
      expect(harness.settlements).toHaveLength(outcome === 'pending' ? 5 : 1);
      for (const request of harness.settlements) expect(request).toEqual(harness.settlements[0]);
    } finally {
      await harness.close();
    }
  });

  it('retries pending settlement with the same identifier before executing once', async () => {
    const harness = await fixture({ flow: 'upfront', outcome: 'pending-success' });
    try {
      const { payment } = await challenge(harness);
      const response = await harness.request(payment);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(harness.events).toEqual(['settle', 'settle', 'handler']);
      expect(harness.settlements[0]).toEqual(harness.settlements[1]);
      expect(harness.settlements[0]?.paymentPayload.extensions).toHaveProperty('payment-identifier');
    } finally {
      await harness.close();
    }
  });

  it.each(['error', 'throw'] as const)(
    'retains the paid receipt on handler %s without a second settlement',
    async (handler) => {
      const harness = await fixture({ flow: 'upfront', handler });
      try {
        const { payment } = await challenge(harness);
        const response = await harness.request(payment);
        expect(response.status).toBe(500);
        await response.arrayBuffer();
        expect(harness.events).toEqual(['settle', 'handler']);
        const receipt = response.headers.get('payment-response');
        if (receipt === null) throw new Error('Missing paid failure receipt');
        expect(decodePaymentResponseHeader(receipt).success).toBe(true);
      } finally {
        await harness.close();
      }
    },
  );

  it('rejects malformed and mismatched payments without contacting the facilitator or executing', async () => {
    const harness = await fixture({ flow: 'upfront' });
    try {
      const { accepted } = await challenge(harness);
      for (const payment of [
        'not-base64',
        encodePaymentSignatureHeader({ x402Version: 2, accepted: { ...accepted, amount: '1' }, payload: {} }),
        encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: { ...accepted, extra: { ...accepted.extra, paymentFlow: 'authorization' } },
          payload: {},
        }),
      ]) {
        const response = await harness.request(payment);
        expect(response.status).toBeGreaterThanOrEqual(400);
        await response.arrayBuffer();
      }
      expect(harness.events).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('preserves payment identity across concurrent and repeated submissions without promising fulfillment deduplication', async () => {
    const harness = await fixture({ flow: 'upfront' });
    try {
      const { payment } = await challenge(harness);
      const responses = await Promise.all([harness.request(payment), harness.request(payment)]);
      responses.push(await harness.request(payment));
      for (const response of responses) {
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
      expect(harness.settlements).toHaveLength(3);
      for (const request of harness.settlements) expect(request).toEqual(harness.settlements[0]);
      expect(harness.events.filter((event) => event === 'handler')).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });
});
