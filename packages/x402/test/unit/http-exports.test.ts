import * as upstream from '@x402/core/http';
import { describe, expect, it } from 'vitest';

import * as http from '../../src/http/index.js';
import type { PaymentRequired, SettleResponse } from '../../src/http/index.js';

describe('public HTTP codecs', () => {
  it('exports the upstream functions without wrapping them', () => {
    expect(http.decodePaymentRequiredHeader).toBe(upstream.decodePaymentRequiredHeader);
    expect(http.decodePaymentResponseHeader).toBe(upstream.decodePaymentResponseHeader);
    expect(http.encodePaymentRequiredHeader).toBe(upstream.encodePaymentRequiredHeader);
    expect(http.encodePaymentResponseHeader).toBe(upstream.encodePaymentResponseHeader);
  });

  it('round-trips payment requirements and settlement responses', () => {
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: 'https://seller.example/resource', description: 'Resource', mimeType: 'application/json' },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0x1234',
          amount: '1000',
          payTo: '0x5678',
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    };
    const settled: SettleResponse = { success: true, transaction: '0x1234', network: 'eip155:8453' };
    expect(http.decodePaymentRequiredHeader(http.encodePaymentRequiredHeader(required))).toEqual(required);
    expect(http.decodePaymentResponseHeader(http.encodePaymentResponseHeader(settled))).toEqual(settled);
  });
});
