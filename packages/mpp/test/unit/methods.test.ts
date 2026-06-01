import { describe, expect, it } from 'vitest';

import { charge, inflow, inflowChargeRequestSchema, inflowCredentialPayloadSchema } from '../../src/methods.js';

describe('inflow charge request schema', () => {
  it('accepts a well-formed request with nested methodDetails', () => {
    const parsed = inflowChargeRequestSchema.parse({
      amount: '10.50',
      currency: 'USDC',
      recipient: '11111111-1111-1111-1111-111111111111',
      methodDetails: { rail: 'balance' },
    });
    expect(parsed.amount).toBe('10.50');
    expect(parsed.methodDetails?.rail).toBe('balance');
  });

  it('accepts a balance request that omits methodDetails', () => {
    expect(inflowChargeRequestSchema.safeParse({ amount: '1', currency: 'USDC' }).success).toBe(true);
  });

  it('keeps amounts as decimal strings and rejects exponent / non-decimal forms', () => {
    expect(inflowChargeRequestSchema.safeParse({ amount: '1e3', currency: 'USDC' }).success).toBe(false);
    expect(inflowChargeRequestSchema.safeParse({ amount: '1,000', currency: 'USDC' }).success).toBe(false);
    expect(inflowChargeRequestSchema.safeParse({ amount: 10, currency: 'USDC' }).success).toBe(false);
    expect(inflowChargeRequestSchema.safeParse({ amount: '10', currency: 'USDC' }).success).toBe(true);
  });

  it('rejects an unknown rail, a non-UUID instrumentId, and a non-UUID recipient', () => {
    expect(
      inflowChargeRequestSchema.safeParse({ amount: '1', currency: 'USDC', methodDetails: { rail: 'wire' } }).success,
    ).toBe(false);
    expect(
      inflowChargeRequestSchema.safeParse({ amount: '1', currency: 'USDC', methodDetails: { instrumentId: 'nope' } })
        .success,
    ).toBe(false);
    expect(
      inflowChargeRequestSchema.safeParse({ amount: '1', currency: 'USDC', recipient: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('accepts an open credential proof payload (including the transactionId correlation key)', () => {
    expect(inflowCredentialPayloadSchema.parse({ approvalId: 'a', transactionId: 'tx_1' })).toEqual({
      approvalId: 'a',
      transactionId: 'tx_1',
    });
  });
});

describe('inflow Method namespace', () => {
  it('defaults to charge and exposes inflow.charge', () => {
    expect(inflow.charge).toBe(charge);
  });
});
