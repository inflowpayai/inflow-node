import { describe, expect, it } from 'vitest';

import { inflowCharges, inflowChargesNodeListener } from '../../src/compose.server.js';

type InflowChargeEntry = readonly ['inflow/charge', { amount: string; currency: string }];

/** A fetch-handler whose return is assignable to the `MethodFn.Response<Http>` shape `toNodeListener` accepts. */
const fetchHandler = (): Promise<{ status: 402; challenge: Response }> =>
  Promise.resolve({ status: 402, challenge: new Response(null, { status: 402 }) });

/** Records the entries `compose` was called with, and returns a handler `inflowCharges` passes straight through. */
function stubMppx() {
  const calls: (readonly InflowChargeEntry[])[] = [];
  return {
    calls,
    handler: fetchHandler,
    compose: (...entries: readonly InflowChargeEntry[]) => {
      calls.push(entries);
      return fetchHandler;
    },
  };
}

const USD = { amount: '1.0', currency: 'USD' };
const USDC = { amount: '0.0095', currency: 'USDC' };

describe('inflowCharges', () => {
  it('builds one inflow/charge compose entry per price, in order', () => {
    const mppx = stubMppx();

    inflowCharges(mppx, [USD, USDC]);

    expect(mppx.calls).toHaveLength(1);
    expect(mppx.calls[0]).toEqual([
      ['inflow/charge', { amount: '1.0', currency: 'USD' }],
      ['inflow/charge', { amount: '0.0095', currency: 'USDC' }],
    ]);
  });

  it('returns the handler produced by compose', () => {
    const mppx = stubMppx();

    expect(inflowCharges(mppx, [USD])).toBe(mppx.handler);
  });

  it('throws on an empty price list', () => {
    expect(() => inflowCharges(stubMppx(), [])).toThrow(/at least one price/);
  });

  it('throws on a duplicate currency', () => {
    expect(() => inflowCharges(stubMppx(), [USD, { amount: '2.0', currency: 'USD' }])).toThrow(/duplicate currency/);
  });

  it('throws on an empty currency', () => {
    expect(() => inflowCharges(stubMppx(), [{ amount: '1.0', currency: '  ' }])).toThrow(/non-empty currency/);
  });

  it('throws on an empty amount', () => {
    expect(() => inflowCharges(stubMppx(), [{ amount: '', currency: 'USD' }])).toThrow(/non-empty amount/);
  });
});

describe('inflowChargesNodeListener', () => {
  it('wraps the composed handler as a Node listener and forwards the entries', () => {
    const mppx = stubMppx();

    const listener = inflowChargesNodeListener(mppx, [USD, USDC]);

    expect(typeof listener).toBe('function');
    expect(mppx.calls[0]).toEqual([
      ['inflow/charge', { amount: '1.0', currency: 'USD' }],
      ['inflow/charge', { amount: '0.0095', currency: 'USDC' }],
    ]);
  });

  it('validates before composing (empty list throws)', () => {
    expect(() => inflowChargesNodeListener(stubMppx(), [])).toThrow(/at least one price/);
  });
});
