import { once } from 'node:events';
import { request as httpRequest } from 'node:http';

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import { InflowApiError } from '@inflowpayai/x402';
import { setSettlementOverrides } from '@x402/express';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload } from '@x402/core/types';
import { PAYMENT_IDENTIFIER } from '@inflowpayai/x402/extensions';
import express from 'express';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createInflowExpressReplayMiddleware } from '../../src/express/index.js';
import type { InflowExpressReplayOptions } from '../../src/express/index.js';
import { ensurePaymentIdentifier } from '../../src/facilitator.js';
import { inflowAccepts } from '../../src/inflow-accepts.js';
import { inflowSchemeRegistrations } from '../../src/scheme-registrations.js';
import { replayDigest } from '../../src/replay.js';
import { TestReplayStore } from '../fixtures/replay-store.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';
import { UPTO_CONFIG, UPTO_KIND } from '../fixtures/upto-config.js';

const PRODUCT = Buffer.from([0, 255, 17, 88, 0]);

interface HarnessOptions {
  store?: TestReplayStore;
  replay?: Partial<InflowExpressReplayOptions>;
  handler?: 'failure' | 'throw' | 'stream' | 'empty' | 'large' | 'html' | 'latin1' | 'array-head' | 'inherited-cache';
  verifyValid?: boolean;
  settled?: boolean;
  settle?: 'failure' | 'ambiguous' | 'conflict';
  verifyConflict?: boolean;
  metered?: boolean;
  blockHandler?: Promise<void>;
  blockVerify?: Promise<void>;
  policy?: 'deny' | 'free';
  changedPrice?: boolean;
  missingRawBody?: boolean;
  port?: number;
  freshHeaders?: (request: Request) => Record<string, string>;
  defaultResponseHeadersOnly?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const store = options.store ?? new TestReplayStore();
  const events: string[] = [];
  let handlers = 0;
  let verifies = 0;
  let settlements = 0;
  const facilitator: FacilitatorClient = {
    getSupported: () =>
      Promise.resolve({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
        extensions: [],
        signers: {},
      }),
    verify: async () => {
      verifies += 1;
      events.push('verify');
      if (verifies === 1) await options.blockVerify;
      if (options.verifyConflict === true)
        throw new InflowApiError('conflict', { code: 'CONFLICT', httpStatus: 409, endpoint: '/verify' });
      return {
        isValid: options.verifyValid ?? true,
        payer: '0xbuyer',
        ...(options.settled === true ? { extensions: { 'payment-identifier': { info: { settled: true } } } } : {}),
      };
    },
    settle: (_payload, requirements) => {
      settlements += 1;
      events.push('settle');
      if (options.settle === 'ambiguous') return Promise.reject(new Error('connection lost after broadcast'));
      if (options.settle === 'conflict')
        return Promise.reject(
          new InflowApiError('conflict', { code: 'CONFLICT', httpStatus: 409, endpoint: '/settle' }),
        );
      return Promise.resolve({
        success: options.settle !== 'failure',
        transaction: '0xoriginal',
        amount: requirements.amount,
        network: requirements.network,
        payer: '0xbuyer',
        ...(options.settle === 'failure' ? { errorReason: 'settlement_failed' } : {}),
      });
    },
  };
  const seller = fakeSellerClient(options.metered === true ? UPTO_CONFIG : undefined);
  const accepts = await inflowAccepts(seller, {
    price: options.metered === true ? '$0.10' : options.changedPrice === true ? '0.02 USDT' : '0.01 USDT',
    schemes: options.metered === true ? ['upto'] : ['exact'],
    networks: ['eip155:8453'],
  });
  const resourceServer = new x402ResourceServer(facilitator);
  if (options.metered === true)
    facilitator.getSupported = () =>
      Promise.resolve({ kinds: [{ ...UPTO_KIND, network: 'eip155:8453' }], extensions: [], signers: {} });
  for (const registration of await inflowSchemeRegistrations(
    seller,
    options.metered === true ? { schemes: ['upto'] } : {},
  ))
    resourceServer.register(registration.network, registration.server);
  const httpServer = new x402HTTPResourceServer(resourceServer, { 'POST /product': { accepts } });
  if (options.policy !== undefined)
    httpServer.onProtectedRequest(() =>
      Promise.resolve(options.policy === 'deny' ? { abort: true, reason: 'revoked' } : { grantAccess: true }),
    );
  const rawBodies = new WeakMap<Request, Buffer>();
  const app = express();
  app.use((request, response, next) => {
    for (const [name, value] of Object.entries(options.freshHeaders?.(request) ?? {})) response.setHeader(name, value);
    next();
  });
  app.use(
    express.raw({
      type: '*/*',
      limit: '2mb',
      verify(request, _response, body) {
        rawBodies.set(request as Request, Buffer.from(body));
      },
    }),
  );
  const middleware = createInflowExpressReplayMiddleware(httpServer, {
    store,
    scope: 'merchant/service',
    principal: () => 'authenticated-buyer',
    body: (request) => (options.missingRawBody === true ? undefined : rawBodies.get(request)),
    ...(options.defaultResponseHeadersOnly === true ? {} : { responseHeaders: ['x-product'] }),
    ...options.replay,
  });
  app.use(middleware);
  app.post('/product', async (_request, response) => {
    handlers += 1;
    events.push('handler');
    if (options.metered === true) setSettlementOverrides(response, { amount: '7' });
    await options.blockHandler;
    if (options.handler === 'throw') throw new Error('handler crash');
    if (options.handler === 'failure') {
      response.status(500).end('handler failed');
      return;
    }
    if (options.handler === 'stream') response.flushHeaders();
    if (options.handler === 'empty') {
      response.status(204).end();
      return;
    }
    if (options.handler === 'large') {
      response.end(Buffer.alloc(128));
      return;
    }
    if (options.handler === 'html') {
      response.status(202).type('text/html').end('<p>product</p>');
      return;
    }
    if (options.handler === 'latin1') {
      response.status(206).type('application/octet-stream').end('caf\u00e9', 'latin1');
      return;
    }
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Set-Cookie', 'secret=not-replayed');
    if (options.handler === 'array-head')
      response.writeHead(201, 'Product created', [
        'X-Product',
        'original',
        'X-Product',
        'second',
        'Cache-Control',
        'max-age=60',
      ]);
    else if (options.handler === 'inherited-cache') response.writeHead(201, { 'X-Product': 'original' });
    else response.writeHead(201, { 'X-Product': 'original', 'Cache-Control': 'max-age=60' });
    response.write(PRODUCT.subarray(0, 2));
    response.end(PRODUCT.subarray(2));
  });
  app.get('/free', (_request, response) => response.json({ free: true }));
  const server = app.listen(options.port ?? 0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected listener address');
  const url = `http://127.0.0.1:${address.port.toString()}`;
  const request = async (
    payment?: string,
    body: Buffer = Buffer.from('request'),
    headers: Record<string, string> = {},
    path = '/product',
  ) => {
    return new Promise<{ status: number; headers: Headers; body: Buffer }>((resolve, reject) => {
      const request = httpRequest(
        url + path,
        {
          method: path === '/free' ? 'GET' : 'POST',
          agent: false,
          headers: {
            host: 'merchant.example',
            'content-type': 'application/octet-stream',
            ...(payment === undefined ? {} : { 'payment-signature': payment }),
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const item of value) headers.append(name, item);
              else if (value !== undefined) headers.set(name, value);
            }
            resolve({ status: response.statusCode ?? 500, headers, body: Buffer.concat(chunks) });
          });
        },
      );
      request.on('error', reject);
      request.end(path === '/free' ? undefined : body);
    });
  };
  const payment = async () => {
    const challenge = await request();
    const encoded = challenge.headers.get('payment-required');
    if (encoded === null) throw new Error('expected payment challenge');
    const accepted = decodePaymentRequiredHeader(encoded).accepts[0];
    if (accepted === undefined) throw new Error('expected payment requirement');
    const identifier = PAYMENT_IDENTIFIER.buildPayloadEntry(PAYMENT_IDENTIFIER.buildDeclaration({}), {
      providedPaymentId: 'pay_original_payment_12345678',
    });
    if (identifier === null) throw new Error('expected payment identifier');
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted,
      payload: { signature: '0xoriginal' },
      extensions: { 'payment-identifier': identifier },
    };
    return { payload, header: encodePaymentSignatureHeader(payload) };
  };
  return {
    store,
    request,
    payment,
    events,
    httpServer,
    port: address.port,
    counts: () => ({ handlers, verifies, settlements }),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

describe('actual foundation Express response replay', () => {
  it('runs verify -> handler -> settle once, then replays original bytes/status/allowed headers/settlement', async () => {
    const app = await harness();
    try {
      const { header } = await app.payment();
      const first = await app.request(header);
      const duplicate = await app.request(header);
      expect(first.status).toBe(201);
      expect(duplicate.status).toBe(201);
      expect(first.body).toEqual(PRODUCT);
      expect(duplicate.body).toEqual(PRODUCT);
      for (const name of ['content-type', 'x-product', 'cache-control', 'payment-response'])
        expect(duplicate.headers.get(name)).toBe(first.headers.get(name));
      expect(duplicate.headers.get('set-cookie')).toBeNull();
      const settlement = duplicate.headers.get('payment-response');
      if (settlement === null) throw new Error('expected settlement header');
      expect(decodePaymentResponseHeader(settlement).transaction).toBe('0xoriginal');
      expect(app.events).toEqual(['verify', 'handler', 'settle']);
      expect(app.counts()).toEqual({ handlers: 1, verifies: 1, settlements: 1 });
    } finally {
      await app.close();
    }
  });

  it.each(['body', 'accept', 'payment', 'requirements', 'query'])(
    'rejects changed %s fingerprint with 409 before handler or settlement',
    async (change) => {
      const app = await harness();
      try {
        const { header, payload } = await app.payment();
        await app.request(header);
        const altered =
          change === 'payment'
            ? encodePaymentSignatureHeader({ ...payload, payload: { signature: '0xchanged' } })
            : change === 'requirements'
              ? encodePaymentSignatureHeader({ ...payload, accepted: { ...payload.accepted, amount: '999' } })
              : header;
        const response = await app.request(
          altered,
          Buffer.from(change === 'body' ? 'changed' : 'request'),
          change === 'accept' ? { accept: 'text/plain' } : {},
          change === 'query' ? '/product?q=changed' : '/product',
        );
        expect(response.status).toBe(409);
        expect(app.counts()).toEqual({ handlers: 1, verifies: 1, settlements: 1 });
      } finally {
        await app.close();
      }
    },
  );

  it('serializes identical concurrent requests without running another handler', async () => {
    let release: () => void = () => {};
    const blockHandler = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await harness({ blockHandler });
    try {
      const { header } = await app.payment();
      const first = app.request(header);
      await vi.waitFor(() => expect(app.counts().handlers).toBe(1));
      const duplicate = await app.request(header);
      expect(duplicate.status).toBe(409);
      release();
      expect((await first).status).toBe(201);
      expect(app.counts()).toEqual({ handlers: 1, verifies: 1, settlements: 1 });
    } finally {
      release();
      await app.close();
    }
  });

  it.each(['lookup', 'claim', 'stage', 'complete'] as const)('fails closed when %s storage fails', async (fault) => {
    const store = new TestReplayStore();
    const app = await harness({ store });
    try {
      const { header } = await app.payment();
      store.fault = fault;
      const response = await app.request(header);
      expect(response.status).toBe(503);
      expect(response.body).not.toEqual(PRODUCT);
      expect(app.counts().handlers).toBe(fault === 'stage' || fault === 'complete' ? 1 : 0);
      expect(app.counts().settlements).toBe(fault === 'complete' ? 1 : 0);
      store.fault = undefined;
      if (fault === 'stage') expect((await app.request(header)).status).toBe(409);
    } finally {
      await app.close();
    }
  });

  it.each(['stage', 'complete'] as const)('fences stale %s writes', async (ownershipLost) => {
    const store = new TestReplayStore();
    store.ownershipLost = ownershipLost;
    const app = await harness({ store });
    try {
      const { header } = await app.payment();
      expect((await app.request(header)).status).toBe(503);
      expect(app.counts().settlements).toBe(ownershipLost === 'complete' ? 1 : 0);
    } finally {
      await app.close();
    }
  });

  it.each(['ambiguous', 'failure'] as const)(
    'recovers staged product after %s settlement without verifying or running handler again',
    async (settle) => {
      const store = new TestReplayStore();
      const first = await harness({ store, settle });
      const { header } = await first.payment();
      expect((await first.request(header)).status).toBe(402);
      await first.close();
      store.simulateOwnerCrash();
      const recovered = await harness({ store, port: first.port });
      try {
        const result = await recovered.request(header);
        expect(
          result.status,
          `${result.body.toString()} claims=${store.claims.toString()} ${JSON.stringify(recovered.counts())}`,
        ).toBe(201);
        expect(result.body).toEqual(PRODUCT);
        expect(recovered.counts()).toEqual({ handlers: 0, verifies: 0, settlements: 1 });
      } finally {
        await recovered.close();
      }
    },
  );

  it('recovers a successful settlement whose completed response could not be stored', async () => {
    const store = new TestReplayStore();
    store.fault = 'complete';
    const app = await harness({ store });
    try {
      const { header } = await app.payment();
      expect((await app.request(header)).status).toBe(503);
      store.fault = undefined;
      store.simulateOwnerCrash();
      const response = await app.request(header);
      expect(response.body).toEqual(PRODUCT);
      expect(app.counts()).toEqual({ handlers: 1, verifies: 1, settlements: 2 });
    } finally {
      await app.close();
    }
  });

  it('never creates a handler operation from cached verification when the product record is missing', async () => {
    const app = await harness({ settled: true });
    try {
      const { header } = await app.payment();
      expect((await app.request(header)).status).toBe(409);
      expect(app.store.claims).toBe(0);
      expect(app.counts()).toEqual({ handlers: 0, verifies: 1, settlements: 0 });
    } finally {
      await app.close();
    }
  });

  it.each(['failure', 'throw'] as const)(
    'retains uncertain handler %s as pending and never reruns it',
    async (handler) => {
      const app = await harness({ handler });
      try {
        const { header } = await app.payment();
        expect((await app.request(header)).status).toBe(500);
        app.store.simulateOwnerCrash();
        expect((await app.request(header)).status).toBe(409);
        expect(app.counts()).toEqual({ handlers: 1, verifies: 1, settlements: 0 });
      } finally {
        await app.close();
      }
    },
  );

  it('does not create a claim from invalid verification', async () => {
    const app = await harness({ verifyValid: false });
    try {
      const { header } = await app.payment();
      expect((await app.request(header)).status).toBe(402);
      expect(app.store.claims).toBe(0);
      expect(app.counts().handlers).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('checks current protected-request policy and changed prices before replay', async () => {
    const app = await harness();
    try {
      const { header, payload } = await app.payment();
      await app.request(header);
      app.httpServer.onProtectedRequest(() => Promise.resolve({ abort: true, reason: 'access revoked' }));
      expect((await app.request(header)).status).toBe(403);
      const changed = await harness({ store: app.store, changedPrice: true });
      try {
        expect((await changed.request(encodePaymentSignatureHeader(payload))).status).toBe(402);
      } finally {
        await changed.close();
      }
    } finally {
      await app.close();
    }
  });

  it.each(['empty', 'html'] as const)('preserves a successful %s response', async (handler) => {
    const app = await harness({ handler });
    try {
      const { header } = await app.payment();
      const first = await app.request(header);
      const duplicate = await app.request(header);
      expect(duplicate.status).toBe(first.status);
      expect(duplicate.body).toEqual(first.body);
      expect(app.counts().handlers).toBe(1);
    } finally {
      await app.close();
    }
  });

  it.each(['stream', 'large'] as const)(
    'rejects %s products without settlement or product emission',
    async (handler) => {
      const app = await harness({ handler, replay: { maxResponseBytes: 64 } });
      try {
        const { header } = await app.payment();
        expect((await app.request(header)).status).toBe(503);
        expect(app.counts().settlements).toBe(0);
      } finally {
        await app.close();
      }
    },
  );

  it('keeps free and unpaid requests on the existing foundation path', async () => {
    const app = await harness();
    try {
      expect((await app.request(undefined, undefined, {}, '/free')).status).toBe(200);
      expect((await app.request()).status).toBe(402);
      expect(app.counts()).toEqual({ handlers: 0, verifies: 0, settlements: 0 });
    } finally {
      await app.close();
    }
  });

  it.each([
    { principal: () => undefined, status: 401 },
    { principal: () => '', status: 401 },
    { principal: () => Promise.reject(new Error('unavailable')), status: 400 },
    { maxRequestBytes: 1, status: 413 },
  ])('rejects requests before verification: $status', async ({ status, ...replay }) => {
    const app = await harness({ replay });
    try {
      const { header } = await app.payment();
      expect((await app.request(header)).status).toBe(status);
      expect(app.counts().verifies).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('replays automatically identified payments but binds the entire original envelope', async () => {
    const app = await harness();
    try {
      const { payload } = await app.payment();
      const payment: PaymentPayload = {
        x402Version: payload.x402Version,
        accepted: payload.accepted,
        payload: payload.payload,
      };
      const header = encodePaymentSignatureHeader(payment);
      expect((await app.request(header)).status).toBe(201);
      expect((await app.request(header)).status).toBe(201);
      const withIdentifier = encodePaymentSignatureHeader(ensurePaymentIdentifier(payment) as PaymentPayload);
      expect((await app.request(withIdentifier)).status).toBe(409);
      expect(app.counts()).toEqual({ handlers: 1, verifies: 1, settlements: 1 });
    } finally {
      await app.close();
    }
  });

  it('rejects malformed payment headers without a claim', async () => {
    const app = await harness();
    try {
      expect((await app.request('invalid')).status).toBe(400);
      expect(app.store.claims).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('canonicalizes payment object field ordering', () => {
    expect(replayDigest({ b: [1, true, null], a: 'value' })).toBe(replayDigest({ a: 'value', b: [1, true, null] }));
    expect(() => replayDigest(undefined)).toThrow('JSON values');
  });

  it.each(['latin1', 'array-head'] as const)('preserves %s transport bytes and headers', async (handler) => {
    const app = await harness({ handler, freshHeaders: () => ({ 'x-product': 'pre-helper-default' }) });
    try {
      const { header } = await app.payment();
      const first = await app.request(header);
      const replay = await app.request(header);
      expect(replay.status).toBe(first.status);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers.get('x-product')).toBe(first.headers.get('x-product'));
      if (handler === 'latin1') expect(replay.body).toEqual(Buffer.from([99, 97, 102, 233]));
      else expect(replay.headers.get('x-product')).toBe('original, second');
      expect(app.counts().handlers).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('uses a staged metered amount rather than the signed ceiling on recovery', async () => {
    const app = await harness({ metered: true, settle: 'ambiguous' });
    const { header } = await app.payment();
    expect((await app.request(header)).status).toBe(402);
    const store = app.store;
    await app.close();
    store.simulateOwnerCrash();
    const recovery = await harness({ metered: true, store, port: app.port });
    try {
      const result = await recovery.request(header);
      expect(result.status, result.body.toString()).toBe(201);
      const receipt = result.headers.get('payment-response');
      if (receipt === null) throw new Error('expected receipt');
      expect(decodePaymentResponseHeader(receipt).amount).toBe('7');
      expect(result.headers.get('settlement-overrides')).toBeNull();
      expect(recovery.counts()).toEqual({ verifies: 0, handlers: 0, settlements: 1 });
    } finally {
      await recovery.close();
    }
  });

  it.each(['completed', 'conflict'] as const)(
    'handles a %s claim race after verification without another handler',
    async (outcome) => {
      let release: () => void = () => {};
      const blockVerify = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = await harness({ blockVerify });
      try {
        const { header, payload } = await app.payment();
        const first = app.request(header);
        await vi.waitFor(() => expect(app.counts().verifies).toBe(1));
        const secondHeader =
          outcome === 'conflict'
            ? encodePaymentSignatureHeader({ ...payload, payload: { signature: '0xother' } })
            : header;
        expect((await app.request(secondHeader)).status).toBe(201);
        release();
        expect((await first).status).toBe(outcome === 'completed' ? 201 : 409);
        expect(app.counts()).toEqual({ verifies: 2, handlers: 1, settlements: 1 });
      } finally {
        release();
        await app.close();
      }
    },
  );

  it.each(['verify', 'settle'] as const)('exposes facilitator %s conflicts as HTTP 409', async (operation) => {
    const app = await harness(operation === 'verify' ? { verifyConflict: true } : { settle: 'conflict' });
    try {
      const { header } = await app.payment();
      expect((await app.request(header)).status).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('refuses payment-bearing access that bypassed verification', async () => {
    const app = await harness();
    try {
      const { header } = await app.payment();
      app.httpServer.onProtectedRequest(() => Promise.resolve({ grantAccess: true }));
      expect((await app.request(header)).status).toBe(400);
      expect(app.counts().handlers).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('allows grantAccess on unpaid requests without claiming a payment', async () => {
    const app = await harness({ policy: 'free' });
    try {
      expect((await app.request()).status).toBe(201);
      expect(app.store.claims).toBe(0);
      expect(app.counts()).toEqual({ handlers: 1, verifies: 0, settlements: 0 });
    } finally {
      await app.close();
    }
  });

  it('makes concurrent cross-principal reuse of a payment ID conflict without another handler', async () => {
    let release: () => void = () => {};
    const blockHandler = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await harness({
      blockHandler,
      // Test authentication boundary: the application would resolve these subjects after authenticating each request.
      replay: { principal: (request) => request.get('x-authenticated-test-subject') ?? 'buyer-a' },
    });
    try {
      const { header } = await app.payment();
      const first = app.request(header);
      await vi.waitFor(() => expect(app.counts().handlers).toBe(1));
      expect((await app.request(header, undefined, { 'x-authenticated-test-subject': 'buyer-b' })).status).toBe(409);
      release();
      expect((await first).status).toBe(201);
      expect((await app.request(header, undefined, { 'x-authenticated-test-subject': 'buyer-b' })).status).toBe(409);
      expect(app.counts()).toEqual({ handlers: 1, verifies: 1, settlements: 1 });
    } finally {
      release();
      await app.close();
    }
  });

  it('keeps fresh security, CORS and cookie headers separate from persisted product headers', async () => {
    const app = await harness({
      freshHeaders: (request) => ({
        'content-security-policy': `default-src 'none'; report-uri /${request.get('x-security-policy') ?? 'first'}`,
        'access-control-allow-origin': request.get('origin') ?? 'https://first.example',
        'set-cookie': `session=${request.get('x-security-policy') ?? 'first'}; Secure; HttpOnly`,
        'cache-control': 'public, max-age=3600',
        'payment-response': 'not-a-receipt',
        'x-product': 'pre-helper-default',
      }),
    });
    try {
      const { header } = await app.payment();
      const first = await app.request(header);
      expect(first.headers.get('content-security-policy')).toContain('/first');
      expect(first.headers.get('access-control-allow-origin')).toBe('https://first.example');
      expect(first.headers.get('set-cookie')).toContain('session=first');
      expect(first.headers.get('cache-control')).toContain('private');
      expect(first.headers.get('cache-control')).not.toContain('public');
      expect(first.headers.get('payment-response')).not.toBe('not-a-receipt');
      expect(first.headers.get('x-product')).toBe('original');
      const replay = await app.request(header, undefined, {
        origin: 'https://current.example',
        'x-security-policy': 'current',
      });
      expect(replay.body).toEqual(PRODUCT);
      expect(replay.headers.get('content-security-policy')).toContain('/current');
      expect(replay.headers.get('access-control-allow-origin')).toBe('https://current.example');
      expect(replay.headers.get('set-cookie')).toContain('session=current');
      expect(replay.headers.get('cache-control')).toContain('private');
      expect(replay.headers.get('cache-control')).not.toContain('public');
      expect(app.counts().handlers).toBe(1);
      app.httpServer.onProtectedRequest(() => Promise.resolve({ abort: true, reason: 'revoked' }));
      const denied = await app.request(header, undefined, { 'x-security-policy': 'revoked' });
      expect(denied.status).toBe(403);
      expect(denied.headers.get('content-security-policy')).toContain('/revoked');
    } finally {
      await app.close();
    }
  });

  it.each([
    ['public', 'private'],
    ['PuBlIc, max-age=3600', 'max-age=3600, private'],
    ['public, private, max-age=60', 'private, max-age=60'],
    ['public, example="first, public, second"', 'example="first, public, second", private'],
  ])('makes inherited paid caching private without a public directive: %s', async (policy, expected) => {
    const app = await harness({
      handler: 'inherited-cache',
      freshHeaders: () => ({ 'cache-control': policy }),
    });
    try {
      const { header } = await app.payment();
      const first = await app.request(header);
      const replay = await app.request(header);
      for (const result of [first, replay]) {
        expect(result.status).toBe(201);
        expect(result.body).toEqual(PRODUCT);
        expect(result.headers.get('cache-control')).toBe(expected);
      }
      expect(replay.headers.get('cache-control')).toBe(first.headers.get('cache-control'));
      const record = [...app.store.entries.values()][0]?.record;
      expect(record?.state).toBe('completed');
      if (record?.state !== 'completed') throw new Error('expected persisted paid response');
      expect(record.response.headers['cache-control']).toBe(first.headers.get('cache-control'));
      expect(app.counts()).toEqual({ handlers: 1, verifies: 1, settlements: 1 });
    } finally {
      await app.close();
    }
  });

  it.each(['completed', 'staged'] as const)('applies current byte limits to %s stored products', async (kind) => {
    const app = await harness(kind === 'staged' ? { settle: 'ambiguous' } : {});
    const { header } = await app.payment();
    expect((await app.request(header)).status).toBe(kind === 'staged' ? 402 : 201);
    await app.close();
    app.store.simulateOwnerCrash();
    const recovery = await harness({ store: app.store, replay: { maxResponseBytes: 1 }, port: app.port });
    try {
      expect((await recovery.request(header)).status).toBe(503);
      expect(recovery.counts()).toEqual({ handlers: 0, verifies: 0, settlements: 0 });
    } finally {
      await recovery.close();
    }
  });

  it('applies current byte limits when another process completes during verification', async () => {
    let release: () => void = () => {};
    const blockVerify = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new TestReplayStore();
    const limited = await harness({ store, blockVerify, replay: { maxResponseBytes: 1 } });
    const normal = await harness({ store });
    try {
      const { header } = await normal.payment();
      const first = limited.request(header);
      await vi.waitFor(() => expect(limited.counts().verifies).toBe(1));
      expect((await normal.request(header)).status).toBe(201);
      release();
      expect((await first).status).toBe(503);
      expect(limited.counts()).toEqual({ handlers: 0, verifies: 1, settlements: 0 });
    } finally {
      release();
      await limited.close();
      await normal.close();
    }
  });

  it('sanitizes direct conflicts while preserving fresh security headers', async () => {
    const app = await harness({
      freshHeaders: (request) =>
        request.get('payment-signature') === undefined
          ? {}
          : {
              'content-length': '3',
              'settlement-overrides': '{}',
              'payment-response': 'stale',
              'content-security-policy': "default-src 'none'",
            },
    });
    try {
      const { header } = await app.payment();
      expect((await app.request(header)).status).toBe(201);
      const conflict = await app.request(header, Buffer.from('different'));
      expect(conflict.status).toBe(409);
      expect(JSON.parse(conflict.body.toString())).toEqual({ error: 'payment_replay_conflict' });
      expect(conflict.headers.get('settlement-overrides')).toBeNull();
      expect(conflict.headers.get('payment-response')).toBeNull();
      expect(conflict.headers.get('content-security-policy')).toBe("default-src 'none'");
    } finally {
      await app.close();
    }
  });

  it('does not persist unspecified custom product headers', async () => {
    const app = await harness({ defaultResponseHeadersOnly: true });
    try {
      const { header } = await app.payment();
      expect((await app.request(header)).headers.get('x-product')).toBeNull();
      expect((await app.request(header)).headers.get('x-product')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it.each(['conflict', 'error'] as const)('fails closed when lookup changes before verification: %s', async (kind) => {
    const app = await harness();
    try {
      const { header } = await app.payment();
      const lookup = vi.spyOn(app.store, 'lookup').mockResolvedValueOnce(undefined);
      if (kind === 'conflict') lookup.mockResolvedValueOnce('conflict');
      else lookup.mockRejectedValueOnce(new Error('storage lost'));
      expect((await app.request(header)).status).toBe(kind === 'conflict' ? 409 : 503);
      expect(app.counts()).toEqual({ handlers: 0, verifies: 0, settlements: 0 });
    } finally {
      await app.close();
    }
  });

  it('keeps request-local replay hooks inert on the shared core server outside HTTP requests', async () => {
    const app = await harness();
    try {
      const { payload } = await app.payment();
      expect((await app.httpServer.server.verifyPayment(payload, payload.accepted)).isValid).toBe(true);
      expect((await app.httpServer.server.settlePayment(payload, payload.accepted)).success).toBe(true);
      expect(app.store.claims).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('does not claim a second handler when another owner is pending after verification', async () => {
    let releaseVerify: () => void = () => {};
    let releaseHandler: () => void = () => {};
    const blockVerify = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    const blockHandler = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const app = await harness({ blockVerify, blockHandler });
    try {
      const { header } = await app.payment();
      const first = app.request(header);
      await vi.waitFor(() => expect(app.counts().verifies).toBe(1));
      const second = app.request(header);
      await vi.waitFor(() => expect(app.counts().handlers).toBe(1));
      releaseVerify();
      expect((await first).status).toBe(409);
      releaseHandler();
      expect((await second).status).toBe(201);
      expect(app.counts()).toEqual({ handlers: 1, verifies: 2, settlements: 1 });
    } finally {
      releaseVerify();
      releaseHandler();
      await app.close();
    }
  });

  it('rejects incomplete raw-body capture before a claim', async () => {
    const app = await harness({ missingRawBody: true });
    try {
      const { header } = await app.payment();
      expect((await app.request(header, Buffer.from('request'), { 'content-length': '7' })).status).toBe(400);
      expect(app.store.claims).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects missing raw-body capture on a real chunked request before verification', async () => {
    const app = await harness({
      replay: {
        body: (request) => {
          expect(request.get('transfer-encoding')).toBe('chunked');
          expect(request.get('content-length')).toBeUndefined();
          return undefined;
        },
      },
    });
    try {
      const { header } = await app.payment();
      const result = await app.request(header, Buffer.from('chunked-body'), { 'transfer-encoding': 'chunked' });
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body.toString())).toEqual({ error: 'payment_replay_body_not_captured' });
      expect(app.store.claims).toBe(0);
      expect(app.counts()).toEqual({ verifies: 0, handlers: 0, settlements: 0 });
    } finally {
      await app.close();
    }
  });

  it('allows absent capture only when the request has no declared body', async () => {
    const app = await harness({ missingRawBody: true });
    try {
      const { header } = await app.payment();
      expect((await app.request(header, Buffer.alloc(0))).status).toBe(201);
      expect(app.counts()).toEqual({ verifies: 1, handlers: 1, settlements: 1 });
    } finally {
      await app.close();
    }
  });

  it('rejects captured bytes whose length does not match the declared body', async () => {
    const app = await harness({ replay: { body: () => Buffer.alloc(0) } });
    try {
      const { header } = await app.payment();
      expect((await app.request(header, Buffer.from('request'), { 'content-length': '7' })).status).toBe(400);
      expect(app.store.claims).toBe(0);
      expect(app.counts()).toEqual({ verifies: 0, handlers: 0, settlements: 0 });
    } finally {
      await app.close();
    }
  });

  it('binds captured chunked request bytes and replays without another lifecycle', async () => {
    const app = await harness();
    try {
      const { header } = await app.payment();
      const framing = { 'transfer-encoding': 'chunked' };
      expect((await app.request(header, Buffer.from('chunked-body'), framing)).status).toBe(201);
      expect((await app.request(header, Buffer.from('chunked-body'), framing)).status).toBe(201);
      expect((await app.request(header, Buffer.from('different'), framing)).status).toBe(409);
      expect(app.counts()).toEqual({ verifies: 1, handlers: 1, settlements: 1 });
    } finally {
      await app.close();
    }
  });

  it.each(['same', 'different'] as const)('rejects %s dual payment headers without a claim', async (kind) => {
    const app = await harness();
    try {
      const { header, payload } = await app.payment();
      const legacy =
        kind === 'same' ? header : encodePaymentSignatureHeader({ ...payload, payload: { signature: '0xdifferent' } });
      expect((await app.request(header, undefined, { 'x-payment': legacy })).status).toBe(400);
      expect(app.store.claims).toBe(0);
      expect(app.counts()).toEqual({ verifies: 0, handlers: 0, settlements: 0 });
    } finally {
      await app.close();
    }
  });

  it('preserves foundation rejection of a V2 payload supplied only through the legacy header', async () => {
    const app = await harness();
    try {
      const { header } = await app.payment();
      expect((await app.request(undefined, undefined, { 'x-payment': header })).status).toBe(402);
      expect(app.store.claims).toBe(0);
      expect(app.counts()).toEqual({ verifies: 0, handlers: 0, settlements: 0 });
    } finally {
      await app.close();
    }
  });

  it('requires the test store to own a pending staged product before completion', async () => {
    const app = await harness();
    try {
      const { payload } = await app.payment();
      const store = new TestReplayStore();
      const response = { status: 201, headers: {}, body: PRODUCT };
      expect(await store.complete('missing', 'token', response)).toBe(false);
      const claim = await store.claim('key', 'fingerprint', { isValid: true });
      if (claim.type !== 'owned') throw new Error('expected owner');
      expect(await store.complete('key', claim.token, response)).toBe(false);
      expect(
        await store.stage('key', claim.token, {
          ...response,
          paymentPayload: payload,
          paymentRequirements: payload.accepted,
        }),
      ).toBe(true);
      expect(await store.complete('key', 'other-owner', response)).toBe(false);
      expect(await store.complete('key', claim.token, response)).toBe(true);
      expect(await store.complete('key', claim.token, response)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('bounds payment-error buffering without emitting a product', async () => {
    const app = await harness({ replay: { maxResponseBytes: 32 } });
    try {
      const { header } = await app.payment();
      app.httpServer.onProtectedRequest(() => Promise.resolve({ abort: true, reason: 'denied'.repeat(100) }));
      expect((await app.request(header)).status).toBe(503);
      expect(app.counts().handlers).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.each([
    { scope: '' },
    { requestHeaders: ['Cookie'] },
    { responseHeaders: ['set-cookie'] },
    { maxRequestBytes: 0 },
    { maxResponseBytes: -1 },
  ])('rejects unsafe configuration %j', async (replay) => {
    await expect(harness({ replay })).rejects.toThrow();
  });
});
