import { describe, expect, it } from 'vitest';

import { encode } from '../../src/codec.js';
import {
  subscriptionOptionFingerprint,
  subscriptionOptionFingerprints,
  uniqueFingerprintPrefixes,
} from '../../src/subscription-option.js';
import type { MppChallenge } from '../../src/types.js';

function challenge(overrides: Partial<MppChallenge> = {}): MppChallenge {
  return {
    id: 'unstable-id',
    realm: 'seller.test',
    method: 'inflow',
    intent: 'subscription',
    request: encode({
      amount: '1',
      currency: 'USDC',
      recipient: '11111111-1111-1111-1111-111111111111',
      methodDetails: { rail: 'balance' },
      periodCount: 1,
      periodUnit: 'month',
      subscriptionExpires: '2027-08-12T20:23:46Z',
      externalId: 'monthly-plan',
    }),
    expires: '2026-08-12T20:28:46Z',
    opaque: 'unstable-opaque',
    ...overrides,
  };
}

describe('subscriptionOptionFingerprint', () => {
  it('is stable across challenge binding and absolute expiry changes', () => {
    const first = subscriptionOptionFingerprint(challenge());
    const second = subscriptionOptionFingerprint(
      challenge({
        id: 'different-id',
        expires: '2026-08-12T21:00:00Z',
        opaque: 'different-opaque',
        request: encode({
          amount: '1',
          currency: 'USDC',
          recipient: '11111111-1111-1111-1111-111111111111',
          methodDetails: { rail: 'balance' },
          periodCount: 1,
          periodUnit: 'month',
          subscriptionExpires: '2027-08-12T21:00:00Z',
          externalId: 'monthly-plan',
        }),
      }),
    );

    expect(second).toEqual(first);
    expect(first?.optionId).toHaveLength(12);
    expect(first?.fingerprint).toHaveLength(64);
  });

  it('changes when a stable subscription term changes', () => {
    const monthly = subscriptionOptionFingerprint(challenge());
    const daily = subscriptionOptionFingerprint(
      challenge({
        request: encode({
          amount: '0.1',
          currency: 'USDC',
          recipient: '11111111-1111-1111-1111-111111111111',
          methodDetails: { rail: 'balance' },
          periodCount: 1,
          periodUnit: 'day',
          subscriptionExpires: '2027-08-12T20:23:46Z',
          externalId: 'daily-plan',
        }),
      }),
    );

    expect(daily?.fingerprint).not.toBe(monthly?.fingerprint);
  });

  it('ignores buyer-selected instruments and normalizes equivalent decimal amounts', () => {
    const first = subscriptionOptionFingerprint(challenge());
    const second = subscriptionOptionFingerprint(
      challenge({
        request: encode({
          amount: '01.000',
          currency: 'USDC',
          recipient: '11111111-1111-1111-1111-111111111111',
          methodDetails: { rail: 'balance', instrumentId: '22222222-2222-2222-2222-222222222222' },
          periodCount: 1,
          periodUnit: 'month',
          subscriptionExpires: '2028-01-01T00:00:00Z',
          externalId: 'monthly-plan',
        }),
      }),
    );

    expect(second).toEqual(first);
  });

  it('returns undefined for a charge or malformed request', () => {
    expect(subscriptionOptionFingerprint(challenge({ intent: 'charge' }))).toBeUndefined();
    expect(subscriptionOptionFingerprint(challenge({ request: 'not-base64-json' }))).toBeUndefined();
  });

  it('extends colliding visible prefixes and treats duplicate fingerprints as equivalent', () => {
    const first = `${'a'.repeat(12)}1${'0'.repeat(51)}`;
    const second = `${'a'.repeat(12)}2${'0'.repeat(51)}`;

    const identifiers = uniqueFingerprintPrefixes([first, second, first]);

    expect(identifiers.get(first)).toBe(`${'a'.repeat(12)}1`);
    expect(identifiers.get(second)).toBe(`${'a'.repeat(12)}2`);
    expect(identifiers.size).toBe(2);
  });

  it('uses the same visible identifier for duplicate subscription terms', () => {
    const options = subscriptionOptionFingerprints([challenge(), challenge({ id: 'duplicate' })]);

    expect(options[0]).toEqual(options[1]);
    expect(options[0]?.optionId).toHaveLength(12);
  });
});
