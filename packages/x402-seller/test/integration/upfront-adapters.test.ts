import { getInflowTransactionId } from '@inflowpayai/x402/extensions';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { HTTPRequestContext } from '@x402/core/http';
import {
  paymentMiddlewareFromHTTPServer as fastifyMiddleware,
  x402ResourceServer as FastifyResourceServer,
  x402HTTPResourceServer as FastifyHTTPResourceServer,
} from '@x402/fastify';
import { paymentMiddlewareFromHTTPServer as honoMiddleware } from '@x402/hono';
import { withX402FromHTTPServer } from '@x402/next';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { NextRequest, NextResponse } from 'next/server.js';
import { describe, expect, it, vi } from 'vitest';

import { createInflowResourceServer, createInflowHTTPResourceServer, inflowAccepts } from '../../src/index.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';

describe.each([
  ['Fastify', 'fixed'],
  ['Fastify', 'dynamic'],
  ['Hono', 'fixed'],
  ['Hono', 'dynamic'],
  ['Next', 'fixed'],
  ['Next', 'dynamic'],
] as const)('%s upfront execution with %s prices', (adapter, pricing) => {
  it.each(['success', 'rejected', 'handler-error'] as const)(
    'handles %s without an after-handler charge',
    async (outcome) => {
      const events: string[] = [];
      const facilitator: FacilitatorClient = {
        getSupported: () =>
          Promise.resolve({
            kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
            extensions: [],
            signers: {},
          }),
        verify: () => {
          events.push('verify');
          return Promise.resolve({ isValid: true });
        },
        settle: () => {
          events.push('settle');
          return Promise.resolve({
            success: outcome !== 'rejected',
            network: 'eip155:8453',
            transaction: 'fixture',
            extensions: {
              'inflow-transaction': {
                info: { transactionId: '22222222-2222-4222-8222-222222222222' },
                schema: {
                  type: 'object',
                  properties: { transactionId: { type: 'string', format: 'uuid' } },
                  required: ['transactionId'],
                },
              },
            },
            ...(outcome === 'rejected' ? { errorReason: 'settlement_failed' } : {}),
          });
        },
      };
      const seller = fakeSellerClient();
      const price = vi.fn((context: HTTPRequestContext) => {
        if (adapter === 'Fastify') expect(context.adapter.getBody?.()).toBeUndefined();
        const amount = context.adapter.getQueryParam?.('amount');
        return { amount: typeof amount === 'string' ? amount : '1', currency: 'USDC' };
      });
      const makeRoute = async (resolvedPrice: Parameters<typeof inflowAccepts>[1]['price']) => ({
        accepts: await inflowAccepts(seller, {
          price: resolvedPrice,
          schemes: ['exact'],
          networks: ['eip155:8453'],
          paymentFlow: 'upfront',
        }),
      });
      const route =
        pricing === 'dynamic' ? (context: HTTPRequestContext) => makeRoute(price(context)) : await makeRoute('1 USDC');
      const server = await createInflowResourceServer(seller, facilitator);
      const status = outcome === 'handler-error' ? 500 : 200;
      let request: (headers?: Record<string, string>) => Promise<Response>;
      let close = () => Promise.resolve();
      if (adapter === 'Fastify') {
        const app = Fastify();
        const fastifyServer = await createInflowResourceServer(seller, facilitator, {
          resourceServer: FastifyResourceServer,
        });
        fastifyMiddleware(
          app,
          createInflowHTTPResourceServer(
            fastifyServer,
            { 'POST /report': route },
            { httpServer: FastifyHTTPResourceServer },
          ),
        );
        app.post('/report', (incoming, reply) => {
          expect(incoming.body).toEqual({ quantity: 3 });
          events.push('handler');
          return reply.status(status).send({ report: true });
        });
        await app.ready();
        request = async (headers = {}) => {
          const response = await app.inject({
            method: 'POST',
            url: '/report?amount=0.25',
            headers,
            payload: { quantity: 3 },
          });
          const output = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const item of value) output.append(name, item);
            else if (value !== undefined) output.set(name, String(value));
          }
          return new Response(response.body, { status: response.statusCode, headers: output });
        };
        close = () => app.close();
      } else if (adapter === 'Hono') {
        const app = new Hono();
        app.use('*', honoMiddleware(createInflowHTTPResourceServer(server, { 'GET /report': route })));
        app.get('/report', (context) => {
          events.push('handler');
          return context.json({ report: true }, status);
        });
        request = async (headers = {}) => app.request('http://localhost/report?amount=0.25', { headers });
      } else {
        const handler = withX402FromHTTPServer(
          () => {
            events.push('handler');
            return Promise.resolve(NextResponse.json({ report: true }, { status }));
          },
          createInflowHTTPResourceServer(server, { 'GET /report': route }),
        );
        request = async (headers = {}) => {
          const response: unknown = await handler(new NextRequest('http://localhost/report?amount=0.25', { headers }));
          if (!(response instanceof Response)) throw new Error('Expected Next response');
          return response;
        };
      }
      try {
        expect(price).not.toHaveBeenCalled();
        const challenge = await request();
        expect(challenge.status).toBe(402);
        const header = challenge.headers.get('payment-required');
        if (header === null) throw new Error('Missing challenge');
        const accepted = decodePaymentRequiredHeader(header).accepts[0];
        if (accepted === undefined) throw new Error('Missing requirements');
        expect(accepted.amount).toBe(pricing === 'dynamic' ? '250000' : '1000000');
        expect(events).toEqual([]);
        const response = await request({
          'payment-signature': encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: {} }),
        });
        expect(response.status).toBe(outcome === 'rejected' ? 402 : status);
        expect(price).toHaveBeenCalledTimes(pricing === 'dynamic' ? 2 : 0);
        expect(events).toEqual(outcome === 'rejected' ? ['settle'] : ['settle', 'handler']);
        const receipt = response.headers.get('payment-response');
        if (receipt === null) throw new Error('Missing settlement receipt');
        expect(decodePaymentResponseHeader(receipt).success).toBe(outcome !== 'rejected');
        expect(getInflowTransactionId(decodePaymentResponseHeader(receipt))).toBe(
          outcome === 'rejected' ? undefined : '22222222-2222-4222-8222-222222222222',
        );
      } finally {
        await close();
      }
    },
  );
});

describe.each(['Hono', 'Next'] as const)('%s body-based authorization pricing', (adapter) => {
  it.each([true, false])('preserves the body and resolved route when settlement success is %s', async (success) => {
    const events: string[] = [];
    const facilitator: FacilitatorClient = {
      getSupported: () =>
        Promise.resolve({
          kinds: [{ x402Version: 2, scheme: 'balance', network: 'inflow:1' }],
          extensions: [],
          signers: {},
        }),
      verify: () => {
        events.push('verify');
        return Promise.resolve({ isValid: true });
      },
      settle: (_payment, requirements) => {
        events.push('settle');
        expect(requirements.amount).toBe('250000000000000000');
        return Promise.resolve({
          success,
          transaction: 'fixture',
          network: requirements.network,
          ...(success ? {} : { errorReason: 'settlement_failed' }),
        });
      },
    };
    const seller = fakeSellerClient();
    const resolveRoute = vi.fn(async (context: HTTPRequestContext) => {
      const body: unknown = await context.adapter.getBody?.();
      expect(body).toEqual({ tier: 'premium' });
      if (typeof body !== 'object' || body === null || !('tier' in body)) throw new Error('Missing tier');
      return {
        accepts: await inflowAccepts(seller, {
          price: body.tier === 'premium' ? '0.25 USDC' : '0.10 USDC',
          schemes: ['balance'],
        }),
        settlementFailedResponseBody: () => ({
          contentType: 'application/json',
          body: { rejectedTier: body.tier },
        }),
      };
    });
    const server = createInflowHTTPResourceServer(await createInflowResourceServer(seller, facilitator), {
      'POST /report': resolveRoute,
    });
    let request: (init: { method: string; body: string; headers: Record<string, string> }) => Promise<Response>;
    if (adapter === 'Hono') {
      const app = new Hono();
      app.use('*', honoMiddleware(server));
      app.post('/report', async (context) => {
        expect(await context.req.json()).toEqual({ tier: 'premium' });
        events.push('handler');
        return context.json({ report: true });
      });
      request = async (init) => app.request('http://localhost/report', init);
    } else {
      const handler = withX402FromHTTPServer(async (incoming: NextRequest) => {
        expect(await incoming.json()).toEqual({ tier: 'premium' });
        events.push('handler');
        return NextResponse.json({ report: true });
      }, server);
      request = async (init) => {
        const response: unknown = await handler(new NextRequest('http://localhost/report', init));
        if (!(response instanceof Response)) throw new Error('Expected Next response');
        return response;
      };
    }
    const init = {
      method: 'POST',
      body: JSON.stringify({ tier: 'premium' }),
      headers: { 'content-type': 'application/json' },
    };
    const challenge = await request(init);
    expect(challenge.status).toBe(402);
    const header = challenge.headers.get('payment-required');
    if (header === null) throw new Error('Missing challenge');
    const accepted = decodePaymentRequiredHeader(header).accepts[0];
    if (accepted === undefined) throw new Error('Missing requirements');
    expect(accepted.amount).toBe('250000000000000000');
    expect(events).toEqual([]);
    const response = await request({
      ...init,
      headers: {
        ...init.headers,
        'payment-signature': encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: {} }),
      },
    });
    expect(response.status).toBe(success ? 200 : 402);
    expect(await response.json()).toEqual(success ? { report: true } : { rejectedTier: 'premium' });
    expect(events).toEqual(['verify', 'handler', 'settle']);
    expect(resolveRoute).toHaveBeenCalledTimes(2);
    const receipt = response.headers.get('payment-response');
    if (receipt === null) throw new Error('Missing settlement receipt');
    expect(decodePaymentResponseHeader(receipt).success).toBe(success);
  });
});
