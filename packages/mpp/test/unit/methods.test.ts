import { describe, expect, it } from 'vitest';

import {
  charge,
  inflow,
  inflowChargeRequestSchema,
  inflowCredentialPayloadSchema,
  tempo,
  tempoCharge,
  tempoChargeRequestSchema,
  tempoCredentialPayloadSchema,
} from '../../src/methods.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const MEMO = '0x0000000000000000000000000000000000000000000000000000000000001234';

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

describe('tempo charge request schema', () => {
  it('accepts a request with bytes32 primary and split memos', () => {
    const parsed = tempoChargeRequestSchema.parse({
      amount: '100',
      currency: ADDRESS,
      recipient: ADDRESS,
      methodDetails: {
        memo: MEMO,
        splits: [{ amount: '10', memo: MEMO, recipient: ADDRESS }],
        supportedModes: ['pull'],
      },
    });
    expect(parsed.methodDetails?.memo).toBe(MEMO);
    expect(parsed.methodDetails?.splits?.[0]?.memo).toBe(MEMO);
  });

  it('rejects non-bytes32 primary and split memos', () => {
    expect(
      tempoChargeRequestSchema.safeParse({
        amount: '100',
        currency: ADDRESS,
        recipient: ADDRESS,
        methodDetails: { memo: '0x1234' },
      }).success,
    ).toBe(false);
    expect(
      tempoChargeRequestSchema.safeParse({
        amount: '100',
        currency: ADDRESS,
        recipient: ADDRESS,
        methodDetails: { splits: [{ amount: '10', memo: '0x1234', recipient: ADDRESS }] },
      }).success,
    ).toBe(false);
  });

  it('accepts pull, push, and proof credential payloads', () => {
    expect(
      tempoCredentialPayloadSchema.parse({ type: 'transaction', signature: '0x76deadbeef', transactionId: 'tx-tempo' })
        .transactionId,
    ).toBe('tx-tempo');
    expect(tempoCredentialPayloadSchema.safeParse({ type: 'hash', hash: '0x1234' }).success).toBe(true);
    expect(tempoCredentialPayloadSchema.safeParse({ type: 'proof', signature: '0xabcd' }).success).toBe(true);
  });
});

describe('tempo Method namespace', () => {
  it('defaults to charge and exposes tempo.charge', () => {
    expect(tempo.charge).toBe(tempoCharge);
  });
});
