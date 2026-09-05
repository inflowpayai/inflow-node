import { once } from 'node:events';

import { paymentMiddlewareFromConfig as expressPaymentMiddleware } from '@x402/express';
import { paymentMiddlewareFromConfig as fastifyPaymentMiddleware } from '@x402/fastify';
import { paymentMiddlewareFromConfig as honoPaymentMiddleware } from '@x402/hono';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  type RoutesConfig,
} from '@x402/core/http';
import { x402ResourceServer, type FacilitatorClient, type RouteConfig } from '@x402/core/server';
import { paymentProxyFromConfig, withX402 } from '@x402/next';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { NextRequest, NextResponse } from 'next/server.js';
import { describe, expect, it } from 'vitest';

import { inflowAccepts } from '../../src/inflow-accepts.js';
import { inflowSchemeRegistrations, type InflowSchemeRegistration } from '../../src/scheme-registrations.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';

const RESOURCE_PATH = '/api/widgets';
const ROUTE = `GET ${RESOURCE_PATH}`;
const FREE_PATH = '/free';
const BASE_URL = 'http://localhost';

type FacilitatorOutcome = 'permit2-allowance-required' | 'settlement-failure' | 'success';

interface ObservedResponse {
  status: number;
  headers: Headers;
}

interface AdapterHarness {
  request(options?: RequestOptions): Promise<ObservedResponse>;
  close(): Promise<void>;
}

interface RequestOptions {
  path?: string;
  headers?: Record<string, string>;
}

interface Composition {
  routeConfig: RouteConfig;
  routes: RoutesConfig;
  registrations: InflowSchemeRegistration[];
}

interface AdapterCase {
  name: string;
  create: (outcome: FacilitatorOutcome) => Promise<AdapterHarness>;
  createSuccess?: (outcome: FacilitatorOutcome) => Promise<AdapterHarness>;
  hasDownstreamHandler: boolean;
}

async function createComposition(): Promise<Composition> {
  const seller = fakeSellerClient();
  const accepts = await inflowAccepts(seller, {
    price: '0.01 USDT',
    schemes: ['exact'],
    networks: ['eip155:8453'],
  });

  const routeConfig: RouteConfig = { accepts };
  return {
    routeConfig,
    routes: { [ROUTE]: routeConfig },
    registrations: await inflowSchemeRegistrations(seller),
  };
}

function facilitator(outcome: FacilitatorOutcome): FacilitatorClient {
  return {
    getSupported: () =>
      Promise.resolve({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
        extensions: [],
        signers: {},
      }),
    verify: () =>
      Promise.resolve(
        outcome === 'permit2-allowance-required'
          ? { isValid: false, invalidReason: 'permit2_allowance_required', payer: '0xBuyer' }
          : { isValid: true, payer: '0xBuyer' },
      ),
    settle: (_paymentPayload, paymentRequirements) =>
      Promise.resolve(
        outcome === 'settlement-failure'
          ? {
              success: false,
              errorReason: 'settlement_failed',
              transaction: '',
              network: paymentRequirements.network,
              payer: '0xBuyer',
            }
          : {
              success: true,
              transaction: '0xSettled',
              network: paymentRequirements.network,
              payer: '0xBuyer',
            },
      ),
  };
}

function paymentHeader(challenge: ObservedResponse): Record<string, string> {
  const encoded = challenge.headers.get('payment-required');
  if (encoded === null) throw new Error('expected PAYMENT-REQUIRED header');
  const required = decodePaymentRequiredHeader(encoded);
  const accepted = required.accepts[0];
  if (accepted === undefined) throw new Error('expected at least one payment requirement');
  if (accepted.extra['assetTransferMethod'] !== 'permit2') throw new Error('expected a Permit2 payment requirement');

  return {
    'payment-signature': encodePaymentSignatureHeader({
      x402Version: 2,
      accepted,
      payload: {},
    }),
  };
}

async function createExpressHarness(outcome: FacilitatorOutcome): Promise<AdapterHarness> {
  const { routes, registrations } = await createComposition();
  const app = express();
  app.use(expressPaymentMiddleware(routes, [facilitator(outcome)], registrations));
  app.get(RESOURCE_PATH, (_request, response) => {
    response.setHeader('Cache-Control', 'max-age=60');
    response.json({ ok: true });
  });
  app.get(FREE_PATH, (_request, response) => {
    response.setHeader('Cache-Control', 'public, max-age=60');
    response.json({ ok: true });
  });

  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected an IP listener');
  const origin = `http://127.0.0.1:${address.port.toString()}`;

  return {
    async request({ path = RESOURCE_PATH, headers = {} } = {}) {
      const response = await fetch(`${origin}${path}`, { headers });
      await response.arrayBuffer();
      return response;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

async function createFastifyHarness(outcome: FacilitatorOutcome): Promise<AdapterHarness> {
  const { routes, registrations } = await createComposition();
  const app = Fastify();
  fastifyPaymentMiddleware(app, routes, [facilitator(outcome)], registrations);
  app.get(RESOURCE_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'max-age=60');
    return { ok: true };
  });
  app.get(FREE_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return { ok: true };
  });
  await app.ready();

  return {
    async request({ path = RESOURCE_PATH, headers = {} } = {}) {
      const response = await app.inject({ method: 'GET', url: path, headers });
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value !== undefined) {
          responseHeaders.set(name, value.toString());
        }
      }
      return { status: response.statusCode, headers: responseHeaders };
    },
    close: () => app.close(),
  };
}

async function createHonoHarness(outcome: FacilitatorOutcome): Promise<AdapterHarness> {
  const { routes, registrations } = await createComposition();
  const app = new Hono();
  app.use('*', honoPaymentMiddleware(routes, [facilitator(outcome)], registrations));
  app.get(RESOURCE_PATH, (context) => {
    context.header('Cache-Control', 'max-age=60');
    return context.json({ ok: true });
  });
  app.get(FREE_PATH, (context) => {
    context.header('Cache-Control', 'public, max-age=60');
    return context.json({ ok: true });
  });

  return {
    async request({ path = RESOURCE_PATH, headers = {} } = {}) {
      const response = await app.request(`${BASE_URL}${path}`, { headers });
      await response.arrayBuffer();
      return response;
    },
    close: () => Promise.resolve(),
  };
}

async function createNextHarness(outcome: FacilitatorOutcome): Promise<AdapterHarness> {
  const { routes, registrations } = await createComposition();
  const proxy = paymentProxyFromConfig(routes, [facilitator(outcome)], registrations);

  return {
    async request({ path = RESOURCE_PATH, headers = {} } = {}) {
      const response: unknown = await proxy(new NextRequest(`${BASE_URL}${path}`, { headers }));
      if (!(response instanceof Response)) throw new Error('expected a Next.js Response');
      return response;
    },
    close: () => Promise.resolve(),
  };
}

async function createNextRouteHarness(outcome: FacilitatorOutcome): Promise<AdapterHarness> {
  const { routeConfig, registrations } = await createComposition();
  const resourceServer = new x402ResourceServer(facilitator(outcome));
  for (const registration of registrations) {
    resourceServer.register(registration.network, registration.server);
  }
  const handler = withX402(
    () =>
      Promise.resolve(
        NextResponse.json(
          { ok: true },
          {
            headers: { 'Cache-Control': 'max-age=60' },
          },
        ),
      ),
    routeConfig,
    resourceServer,
  );

  return {
    async request({ path = RESOURCE_PATH, headers = {} } = {}) {
      const response: unknown = await handler(new NextRequest(`${BASE_URL}${path}`, { headers }));
      if (!(response instanceof Response)) throw new Error('expected a Next.js Response');
      return response;
    },
    close: () => Promise.resolve(),
  };
}

const ADAPTERS: AdapterCase[] = [
  { name: 'Express', create: createExpressHarness, hasDownstreamHandler: true },
  { name: 'Fastify', create: createFastifyHarness, hasDownstreamHandler: true },
  { name: 'Hono', create: createHonoHarness, hasDownstreamHandler: true },
  {
    name: 'Next',
    create: createNextHarness,
    createSuccess: createNextRouteHarness,
    hasDownstreamHandler: false,
  },
];

describe.each(ADAPTERS)('$name seller integration', ({ create, createSuccess, hasDownstreamHandler }) => {
  it('marks an unpaid 402 challenge as no-store', async () => {
    const harness = await create('success');
    try {
      const response = await harness.request();
      expect(response.status).toBe(402);
      expect(response.headers.get('payment-required')).not.toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await harness.close();
    }
  });

  it('marks a Permit2 allowance 412 response as no-store', async () => {
    const harness = await create('permit2-allowance-required');
    try {
      const challenge = await harness.request();
      const response = await harness.request({ headers: paymentHeader(challenge) });
      expect(response.status).toBe(412);
      const encoded = response.headers.get('payment-required');
      if (encoded === null) throw new Error('expected PAYMENT-REQUIRED header');
      expect(decodePaymentRequiredHeader(encoded).error).toBe('permit2_allowance_required');
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await harness.close();
    }
  });

  it('marks a settlement failure as no-store', async () => {
    const harness = await create('settlement-failure');
    try {
      const challenge = await harness.request();
      const response = await harness.request({ headers: paymentHeader(challenge) });
      expect(response.status).toBe(402);
      const encoded = response.headers.get('payment-response');
      if (encoded === null) throw new Error('expected PAYMENT-RESPONSE header');
      expect(decodePaymentResponseHeader(encoded)).toMatchObject({
        success: false,
        errorReason: 'settlement_failed',
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      await harness.close();
    }
  });

  it('does not add payment cache controls to an unprotected route', async () => {
    const harness = await create('success');
    try {
      const response = await harness.request({ path: FREE_PATH });
      expect(response.status).toBe(200);
      expect(response.headers.get('payment-required')).toBeNull();
      expect(response.headers.get('payment-response')).toBeNull();
      expect(response.headers.get('cache-control')).toBe(hasDownstreamHandler ? 'public, max-age=60' : null);
    } finally {
      await harness.close();
    }
  });

  it('marks a successful paid response as private', async () => {
    const harness = await (createSuccess ?? create)('success');
    try {
      const challenge = await harness.request();
      const response = await harness.request({ headers: paymentHeader(challenge) });
      expect(response.status).toBe(200);
      const encoded = response.headers.get('payment-response');
      if (encoded === null) throw new Error('expected PAYMENT-RESPONSE header');
      expect(decodePaymentResponseHeader(encoded)).toMatchObject({ success: true, transaction: '0xSettled' });
      expect(response.headers.get('cache-control')).toBe('max-age=60, private');
    } finally {
      await harness.close();
    }
  });
});

describe('Next proxy seller integration', () => {
  it('marks a successful settled continuation as private', async () => {
    const harness = await createNextHarness('success');
    try {
      const challenge = await harness.request();
      const response = await harness.request({ headers: paymentHeader(challenge) });
      expect(response.status).toBe(200);
      const encoded = response.headers.get('payment-response');
      if (encoded === null) throw new Error('expected PAYMENT-RESPONSE header');
      expect(decodePaymentResponseHeader(encoded)).toMatchObject({ success: true, transaction: '0xSettled' });
      expect(response.headers.get('cache-control')).toBe('private');
    } finally {
      await harness.close();
    }
  });
});
