import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createInflowFacilitator, createInflowResourceServer } from '../../src/index.js';
import { SAMPLE_CONFIG, SAMPLE_SUPPORTED } from '../fixtures/config-response.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';

const baseUrl = 'https://facilitator.example';
const server = setupServer();
const accepted = {
  scheme: 'balance',
  network: 'inflow:1' as const,
  asset: 'USD',
  amount: '100',
  payTo: SAMPLE_CONFIG.sellerId,
  maxTimeoutSeconds: 300,
  extra: {},
};
const payload = { x402Version: 2, accepted, payload: { transactionId: 'test-payment' } };
const metadata = { attribution: { status: 'recorded', label: 'café' } };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const facilitator = () => createInflowFacilitator({ apiKey: 'test-key', baseUrl, environment: 'sandbox' });

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('facilitator extension response headers', () => {
  it('delivers distinct verification and settlement metadata to real upstream hooks', async () => {
    server.use(
      http.get(`${baseUrl}/v1/x402/supported`, () => HttpResponse.json(SAMPLE_SUPPORTED)),
      http.post(`${baseUrl}/v1/x402/verify`, () =>
        HttpResponse.json(
          { isValid: true },
          {
            headers: { 'EXTENSION-RESPONSES': encode(metadata) },
          },
        ),
      ),
      http.post(`${baseUrl}/v1/x402/settle`, () =>
        HttpResponse.json(
          { success: true, transaction: 'tx', network: accepted.network },
          {
            headers: { 'EXTENSION-RESPONSES': encode({ settlement: { status: 'recorded' } }) },
          },
        ),
      ),
    );
    const resource = await createInflowResourceServer(fakeSellerClient(SAMPLE_CONFIG), facilitator());
    const seen: unknown[] = [];
    resource.onAfterVerify(({ result }) => {
      seen.push(result.extensionResponses);
      return Promise.resolve();
    });
    resource.onAfterSettle(({ result }) => {
      seen.push(result.extensionResponses);
      return Promise.resolve();
    });
    await resource.initialize();
    await resource.verifyPayment(payload, accepted);
    await resource.settlePayment(payload, accepted);
    expect(seen).toEqual([metadata, { settlement: { status: 'recorded' } }]);
  });

  it.each([
    undefined,
    '',
    'invalid-base64!',
    encode(null),
    encode([]),
    encode(3),
    encode('text'),
    Buffer.from('{').toString('base64'),
  ])('ignores absent or malformed metadata without retrying settlement: %s', async (header) => {
    let calls = 0;
    const body = {
      success: true,
      transaction: 'tx',
      network: accepted.network,
      extensions: { receipt: { id: 'retained' } },
    };
    server.use(
      http.post(`${baseUrl}/v1/x402/settle`, () => {
        calls += 1;
        return HttpResponse.json(body, { headers: header === undefined ? {} : { 'EXTENSION-RESPONSES': header } });
      }),
    );
    expect(await facilitator().settle(payload, accepted)).toEqual(body);
    expect(calls).toBe(1);
  });

  it('keeps metadata on a normalized Permit2 allowance response', async () => {
    server.use(
      http.post(`${baseUrl}/v1/x402/verify`, () =>
        HttpResponse.json(
          { isValid: false, invalidReason: 'permit2_allowance_required' },
          { status: 412, headers: { 'EXTENSION-RESPONSES': encode(metadata) } },
        ),
      ),
    );
    expect(await facilitator().verify(payload, accepted)).toEqual({
      isValid: false,
      invalidReason: 'permit2_allowance_required',
      extensionResponses: metadata,
    });
  });

  it('does not share response metadata across concurrent requests', async () => {
    server.use(
      http.post(`${baseUrl}/v1/x402/verify`, async ({ request }) => {
        const body = (await request.json()) as { paymentRequirements: { amount: string } };
        return HttpResponse.json(
          { isValid: true },
          { headers: { 'EXTENSION-RESPONSES': encode({ amount: body.paymentRequirements.amount }) } },
        );
      }),
    );
    const client = facilitator();
    const results = await Promise.all(['100', '200'].map((amount) => client.verify(payload, { ...accepted, amount })));
    expect(results.map((result) => result.extensionResponses)).toEqual([{ amount: '100' }, { amount: '200' }]);
  });
});
