import { describe, expect, it } from 'vitest';

import type {
  BalancePayloadData,
  ExactPayloadData,
  InflowPaymentPayload,
  InstrumentPayloadData,
} from '../../src/types.js';
import { isBalancePayload, isExactPayload, isInstrumentPayload, isPermit2Payload } from '../../src/types.js';

function makePayload<T>(scheme: string, payload: T): InflowPaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme,
      network: scheme === 'exact' ? 'eip155:8453' : 'inflow:1',
      asset: scheme === 'exact' ? '0xabc' : '',
      amount: '1000000',
      payTo: '0xseller',
      maxTimeoutSeconds: 300,
      extra: {},
    },
    // Exercise wire values outside the declared payload union at this test boundary.
    payload: payload as InflowPaymentPayload['payload'],
  };
}

describe('payload narrowing helpers', () => {
  it.each([null, undefined, [], 'invalid', 1].map((authorization) => ({ authorization })))(
    'does not narrow invalid authorization $authorization',
    ({ authorization }) => {
      const payload = makePayload('exact', { authorization, permit2Authorization: authorization });
      expect(isExactPayload(payload)).toBe(false);
      expect(isPermit2Payload(payload)).toBe(false);
    },
  );

  it('distinguishes Permit2 from EIP-3009 and other schemes', () => {
    const permit2 = {
      signature: '0xsig',
      permit2Authorization: {
        permitted: { token: '0xtoken', amount: '1' },
        from: '0xbuyer',
        spender: '0xproxy',
        nonce: '1',
        deadline: '9999999999',
        witness: { to: '0xseller', validAfter: '0', extra: '0x' },
      },
    };
    expect(isPermit2Payload(makePayload('exact', permit2))).toBe(true);
    expect(isExactPayload(makePayload('exact', permit2))).toBe(false);
    expect(isPermit2Payload(makePayload('balance', permit2))).toBe(false);
    expect(isPermit2Payload(makePayload('exact', { authorization: {} }))).toBe(false);
  });
  const balance: BalancePayloadData = {
    transactionId: '00000000-0000-0000-0000-000000000abc',
  };
  const exact: ExactPayloadData = {
    authorization: {
      from: '0x1',
      to: '0x2',
      value: '1',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: '0xnonce',
    },
    signature: '0xsig',
  };
  const instrument: InstrumentPayloadData = {
    transactionId: '00000000-0000-0000-0000-000000000abc',
  };

  it('isBalancePayload narrows on accepted.scheme === "balance"', () => {
    expect(isBalancePayload(makePayload('balance', balance))).toBe(true);
    expect(isBalancePayload(makePayload('exact', exact))).toBe(false);
    expect(isBalancePayload(makePayload('instrument', instrument))).toBe(false);
  });

  it('isExactPayload narrows on accepted.scheme === "exact"', () => {
    expect(isExactPayload(makePayload('exact', exact))).toBe(true);
    expect(isExactPayload(makePayload('balance', balance))).toBe(false);
  });

  it('isInstrumentPayload narrows on accepted.scheme === "instrument"', () => {
    expect(isInstrumentPayload(makePayload('instrument', instrument))).toBe(true);
    expect(isInstrumentPayload(makePayload('balance', balance))).toBe(false);
  });
});
