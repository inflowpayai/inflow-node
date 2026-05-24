import { describe, expect, it } from 'vitest';

import type {
  BalancePayloadData,
  ExactPayloadData,
  InflowPaymentPayload,
  InstrumentPayloadData,
} from '../../src/types.js';
import { isBalancePayload, isExactPayload, isInstrumentPayload } from '../../src/types.js';

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
    payload: payload as unknown as InflowPaymentPayload['payload'],
  };
}

describe('payload narrowing helpers', () => {
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
    transactionId: 'tx_1',
    signature: 'sig_1',
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
