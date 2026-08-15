import { describe, expect, it } from 'vitest';

import {
  inflowCharges,
  inflowChargesNodeListener,
  inflowSubscriptions,
  inflowSubscriptionsNodeListener,
} from '../../src/compose.server.js';
import type { InflowSubscriptionPlan } from '../../src/compose.server.js';

type InflowChargeEntry = readonly ['inflow/charge', { amount: string; currency: string }];

type InflowSubscriptionEntry = readonly [
  'inflow/subscription',
  {
    amount: string;
    currency: string;
    periodUnit: string;
    periodCount: number;
    subscriptionExpires: string;
    externalId?: string;
  },
];

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

/** Records the entries `compose` was called with, and returns a handler `inflowSubscriptions` passes straight through. */
function stubSubMppx() {
  const calls: (readonly InflowSubscriptionEntry[])[] = [];
  return {
    calls,
    handler: fetchHandler,
    compose: (...entries: readonly InflowSubscriptionEntry[]) => {
      calls.push(entries);
      return fetchHandler;
    },
  };
}

const MONTHLY: InflowSubscriptionPlan = {
  amount: '9.99',
  currency: 'USDC',
  periodUnit: 'month',
  periodCount: 1,
  subscriptionExpires: '2027-01-01T00:00:00Z',
};
const YEARLY: InflowSubscriptionPlan = {
  amount: '99',
  currency: 'PYUSD',
  periodUnit: 'year',
  periodCount: 1,
  subscriptionExpires: '2027-01-01T00:00:00Z',
};

describe('inflowSubscriptions', () => {
  it('builds one inflow/subscription compose entry per plan, in order', () => {
    const mppx = stubSubMppx();

    inflowSubscriptions(mppx, [MONTHLY, YEARLY]);

    expect(mppx.calls).toHaveLength(1);
    expect(mppx.calls[0]).toEqual([
      [
        'inflow/subscription',
        {
          amount: '9.99',
          currency: 'USDC',
          periodUnit: 'month',
          periodCount: 1,
          subscriptionExpires: '2027-01-01T00:00:00Z',
        },
      ],
      [
        'inflow/subscription',
        {
          amount: '99',
          currency: 'PYUSD',
          periodUnit: 'year',
          periodCount: 1,
          subscriptionExpires: '2027-01-01T00:00:00Z',
        },
      ],
    ]);
  });

  it('carries externalId when provided', () => {
    const mppx = stubSubMppx();

    inflowSubscriptions(mppx, [{ ...MONTHLY, externalId: 'plan_pro' }]);

    expect(mppx.calls[0]).toEqual([
      [
        'inflow/subscription',
        {
          amount: '9.99',
          currency: 'USDC',
          periodUnit: 'month',
          periodCount: 1,
          subscriptionExpires: '2027-01-01T00:00:00Z',
          externalId: 'plan_pro',
        },
      ],
    ]);
  });

  it('returns the handler produced by compose', () => {
    const mppx = stubSubMppx();

    expect(inflowSubscriptions(mppx, [MONTHLY])).toBe(mppx.handler);
  });

  it('throws on an empty plan list', () => {
    expect(() => inflowSubscriptions(stubSubMppx(), [])).toThrow(/at least one plan/);
  });

  it('allows multiple plans in one currency when their terms differ', () => {
    const mppx = stubSubMppx();

    inflowSubscriptions(mppx, [MONTHLY, { ...MONTHLY, amount: '5', externalId: 'second-plan' }]);

    expect(mppx.calls[0]).toHaveLength(2);
  });

  it('throws on an empty currency', () => {
    expect(() => inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, currency: '  ' }])).toThrow(/non-empty currency/);
  });

  it('throws on an empty amount', () => {
    expect(() => inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, amount: '' }])).toThrow(/non-empty amount/);
  });

  it('throws on a non-positive periodCount', () => {
    expect(() => inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, periodCount: 0 }])).toThrow(
      /positive safe-integer periodCount/,
    );
  });

  it('requires at least five minutes per billing period', () => {
    expect(() => inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, periodUnit: 'minute', periodCount: 4 }])).toThrow(
      /periodCount of at least 5 for minute/,
    );
    expect(() =>
      inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, periodUnit: 'minute', periodCount: 5 }]),
    ).not.toThrow();
  });

  it('throws on an unsafe periodCount, malformed amount or expiration, and invalid externalId', () => {
    expect(() =>
      inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, periodCount: Number.MAX_SAFE_INTEGER + 1 }]),
    ).toThrow(/positive safe-integer periodCount/);
    expect(() => inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, amount: '-1' }])).toThrow(/positive decimal amount/);
    expect(() => inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, subscriptionExpires: '2027-01-01' }])).toThrow(
      /RFC 3339 subscriptionExpires/,
    );
    expect(() => inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, externalId: ' ' }])).toThrow(
      /externalId must contain 1 to 128 characters/,
    );
    expect(() => inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, externalId: 'x'.repeat(129) }])).toThrow(
      /externalId must contain 1 to 128 characters/,
    );
  });

  it('throws on an empty subscriptionExpires', () => {
    expect(() => inflowSubscriptions(stubSubMppx(), [{ ...MONTHLY, subscriptionExpires: '  ' }])).toThrow(
      /non-empty subscriptionExpires/,
    );
  });
});

describe('inflowSubscriptionsNodeListener', () => {
  it('wraps the composed handler as a Node listener and forwards the entries', () => {
    const mppx = stubSubMppx();

    const listener = inflowSubscriptionsNodeListener(mppx, [MONTHLY]);

    expect(typeof listener).toBe('function');
    expect(mppx.calls[0]).toEqual([
      [
        'inflow/subscription',
        {
          amount: '9.99',
          currency: 'USDC',
          periodUnit: 'month',
          periodCount: 1,
          subscriptionExpires: '2027-01-01T00:00:00Z',
        },
      ],
    ]);
  });

  it('validates before composing (empty list throws)', () => {
    expect(() => inflowSubscriptionsNodeListener(stubSubMppx(), [])).toThrow(/at least one plan/);
  });
});
