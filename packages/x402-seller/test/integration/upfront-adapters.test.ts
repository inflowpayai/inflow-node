import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import { paymentMiddlewareFromConfig as fastifyMiddleware } from '@x402/fastify';
import { paymentMiddlewareFromConfig as honoMiddleware } from '@x402/hono';
import { withX402 } from '@x402/next';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { NextRequest, NextResponse } from 'next/server.js';
import { describe, expect, it } from 'vitest';

import { inflowAccepts, inflowSchemeRegistrations } from '../../src/index.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';

describe.each(['Fastify', 'Hono', 'Next'] as const)('%s upfront execution', (adapter) => {
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
            ...(outcome === 'rejected' ? { errorReason: 'settlement_failed' } : {}),
          });
        },
      };
      const seller = fakeSellerClient();
      const route = {
        accepts: await inflowAccepts(seller, {
          price: '1 USDC',
          schemes: ['exact'],
          networks: ['eip155:8453'],
          paymentFlow: 'upfront',
        }),
      };
      const registrations = await inflowSchemeRegistrations(seller);
      const status = outcome === 'handler-error' ? 500 : 200;
      let request: (headers?: Record<string, string>) => Promise<Response>;
      let close = () => Promise.resolve();
      if (adapter === 'Fastify') {
        const app = Fastify();
        fastifyMiddleware(app, { 'GET /report': route }, [facilitator], registrations);
        app.get('/report', (_request, reply) => {
          events.push('handler');
          return reply.status(status).send({ report: true });
        });
        await app.ready();
        request = async (headers = {}) => {
          const response = await app.inject({ method: 'GET', url: '/report', headers });
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
        app.use('*', honoMiddleware({ 'GET /report': route }, [facilitator], registrations));
        app.get('/report', (context) => {
          events.push('handler');
          return context.json({ report: true }, status);
        });
        request = async (headers = {}) => app.request('http://localhost/report', { headers });
      } else {
        const server = new x402ResourceServer(facilitator);
        for (const registration of registrations) server.register(registration.network, registration.server);
        const handler = withX402(
          () => {
            events.push('handler');
            return Promise.resolve(NextResponse.json({ report: true }, { status }));
          },
          route,
          server,
        );
        request = async (headers = {}) => {
          const response: unknown = await handler(new NextRequest('http://localhost/report', { headers }));
          if (!(response instanceof Response)) throw new Error('Expected Next response');
          return response;
        };
      }
      try {
        const challenge = await request();
        expect(challenge.status).toBe(402);
        const header = challenge.headers.get('payment-required');
        if (header === null) throw new Error('Missing challenge');
        const accepted = decodePaymentRequiredHeader(header).accepts[0];
        if (accepted === undefined) throw new Error('Missing requirements');
        expect(events).toEqual([]);
        const response = await request({
          'payment-signature': encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: {} }),
        });
        expect(response.status).toBe(outcome === 'rejected' ? 402 : status);
        expect(events).toEqual(outcome === 'rejected' ? ['settle'] : ['settle', 'handler']);
        const receipt = response.headers.get('payment-response');
        if (receipt === null) throw new Error('Missing settlement receipt');
        expect(decodePaymentResponseHeader(receipt).success).toBe(outcome !== 'rejected');
      } finally {
        await close();
      }
    },
  );
});
