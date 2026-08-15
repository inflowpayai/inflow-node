import { describe, expect, it } from 'vitest';

import * as pkg from '../../src/index.js';

describe('public barrel', () => {
  it('exports the inflow factory and context schema', () => {
    expect(typeof pkg.inflow).toBe('function');
    expect(typeof pkg.inflowContextSchema.parse).toBe('function');
  });

  it('re-exports the foundation Mppx and Receipt namespaces', () => {
    expect(typeof pkg.Mppx.create).toBe('function');
    expect(typeof pkg.Receipt.fromResponse).toBe('function');
  });

  it('normalizes legacy and canonical discovery payment offers', () => {
    expect(pkg.Discovery.PaymentInfo.parse({ amount: '10', currency: 'USDC', method: 'inflow' })).toEqual({
      offers: [{ amount: '10', currency: 'USDC', method: 'inflow' }],
    });
    expect(
      pkg.Discovery.PaymentInfo.parse({
        offers: [
          { amount: '10', currency: 'USDC', method: 'inflow' },
          { amount: '10', currency: '0x20c0000000000000000000000000000000000001', method: 'tempo' },
        ],
      }),
    ).toEqual({
      offers: [
        { amount: '10', currency: 'USDC', method: 'inflow' },
        { amount: '10', currency: '0x20c0000000000000000000000000000000000001', method: 'tempo' },
      ],
    });
  });

  it('exports the typed errors', () => {
    expect(typeof pkg.MppPaymentCancelledError).toBe('function');
    expect(typeof pkg.MppPaymentFailedError).toBe('function');
    expect(typeof pkg.MppPaymentExpiredError).toBe('function');
    expect(typeof pkg.MppPaymentTimeoutError).toBe('function');
    expect(typeof pkg.MppMalformedCredentialError).toBe('function');
  });
});
