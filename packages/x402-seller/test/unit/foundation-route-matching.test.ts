import {
  decodePaymentRequiredHeader,
  x402HTTPResourceServer,
  type HTTPAdapter,
  type HTTPRequestContext,
} from '@x402/core/http';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import { describe, expect, it } from 'vitest';

import { inflowAccepts } from '../../src/inflow-accepts.js';
import type { InflowSellerClient } from '../../src/seller-client.js';
import { inflowSchemeRegistrations } from '../../src/scheme-registrations.js';
import { SAMPLE_CONFIG } from '../fixtures/config-response.js';

function fakeSellerClient(): InflowSellerClient {
  return {
    config: () => Promise.resolve(SAMPLE_CONFIG),
    refreshConfig: () => Promise.reject(new Error('refreshConfig: not stubbed')),
    refreshSupported: () => Promise.reject(new Error('refreshSupported: not stubbed')),
    getSignerAddresses: () => Promise.reject(new Error('getSignerAddresses: not stubbed')),
  };
}

class RequestAdapter implements HTTPAdapter {
  constructor(
    private readonly path: string,
    private readonly method: string,
  ) {}

  getHeader(_name: string): string | undefined {
    return undefined;
  }

  getMethod(): string {
    return this.method;
  }

  getPath(): string {
    return this.path;
  }

  getUrl(): string {
    return `https://example.com${this.path}`;
  }

  getAcceptHeader(): string {
    return 'application/json';
  }

  getUserAgent(): string {
    return 'inflow-route-matching-test';
  }

  setHeader(_name: string, _value: string): void {}
}

async function createHttpServer(): Promise<x402HTTPResourceServer> {
  const client = fakeSellerClient();
  const accepts = await inflowAccepts(client, { price: '$0.01' });
  const registrations = await inflowSchemeRegistrations(client);
  const facilitator: FacilitatorClient = {
    getSupported: () =>
      Promise.resolve({
        kinds: registrations.map((registration) => ({
          x402Version: 2,
          scheme: registration.server.scheme,
          network: registration.network,
        })),
        extensions: [],
        signers: {},
      }),
    verify: () => Promise.reject(new Error('verify: not stubbed')),
    settle: () => Promise.reject(new Error('settle: not stubbed')),
  };
  const resourceServer = new x402ResourceServer(facilitator);

  for (const registration of registrations) {
    resourceServer.register(registration.network, registration.server);
  }

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    'GET /api/report/:id': { accepts },
    'GET /api/premium/*': { accepts },
  });
  await httpServer.initialize();
  return httpServer;
}

function context(path: string, method = 'GET'): HTTPRequestContext {
  return {
    adapter: new RequestAdapter(path, method),
    path,
    method,
  };
}

describe('foundation route matching through InFlow seller composition', () => {
  it.each(['/api/report/a%2Fb', '/api/report/a%5Cb', String.raw`/api/report/a\b`])(
    'keeps encoded and raw separators inside a protected parameter: %s',
    async (path) => {
      const server = await createHttpServer();
      expect(server.requiresPayment(context(path))).toBe(true);
    },
  );

  it.each(['/api/premium', '/api/premium/'])(
    'protects the bare prefix of a trailing wildcard route: %s',
    async (path) => {
      const server = await createHttpServer();
      expect(server.requiresPayment(context(path))).toBe(true);
    },
  );

  it.each([
    '/api/premium/report%0A',
    '/api/premium/report%0D',
    '/api/premium/report%E2%80%A8',
    '/api/premium/report%E2%80%A9',
  ])('keeps encoded line terminators inside a protected wildcard: %s', async (path) => {
    const server = await createHttpServer();
    expect(server.requiresPayment(context(path))).toBe(true);
  });

  it('does not overmatch adjacent paths or the wrong HTTP method', async () => {
    const server = await createHttpServer();
    expect(server.requiresPayment(context('/api/premiumx'))).toBe(false);
    expect(server.requiresPayment(context('/api/report/a%2Fb/c'))).toBe(false);
    expect(server.requiresPayment(context('/api/premium', 'POST'))).toBe(false);
  });

  it('keeps authorization defaults and the SDK transfer-method sentinel off the 402 wire', async () => {
    const server = await createHttpServer();
    const result = await server.processHTTPRequest(context('/api/premium'));

    expect(result.type).toBe('payment-error');
    if (result.type !== 'payment-error') throw new Error('expected an unpaid response');
    const encoded = result.response.headers['PAYMENT-REQUIRED'];
    if (encoded === undefined) throw new Error('expected PAYMENT-REQUIRED header');
    const paymentRequired = decodePaymentRequiredHeader(encoded);

    expect(paymentRequired.accepts).not.toHaveLength(0);
    for (const requirement of paymentRequired.accepts) {
      expect(requirement.extra['paymentFlow']).toBeUndefined();
      expect(requirement.extra['assetTransferMethod']).not.toBe('default');
    }
  });
});
