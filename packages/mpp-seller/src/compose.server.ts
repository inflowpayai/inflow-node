import { Mppx } from 'mppx/server';

/**
 * One accepted price for a multi-currency route: an `amount` denominated in `currency`. The rail is not specified here
 * — the `inflow` method derives it from the currency at request time (crypto → `balance`, fiat → `instrument`), exactly
 * as the single-currency `charge` path does.
 */
export interface InflowChargePrice {
  /** Decimal amount string in `currency`'s units, e.g. `'1.0'` or `'0.0095'`. */
  amount: string;
  /** Currency code, e.g. `'USD'` (→ instrument rail) or `'USDC'` (→ balance rail). */
  currency: string;
}

/** The `compose` entry shape for the `inflow` charge method: a `[methodKey, options]` tuple. */
type InflowChargeEntry = readonly ['inflow/charge', { amount: string; currency: string }];

/**
 * The slice of a core `mppx/server` instance this module needs: its `compose(...)`. Kept structural (rather than
 * importing the full instance type) so the helper is generic over any `Mppx.create({ methods: [inflow(...)] })`
 * instance while staying fully typed via inference of the handler return.
 */
interface InflowComposable<Handler> {
  compose: (...entries: readonly InflowChargeEntry[]) => Handler;
}

/**
 * Build the `compose` entries for a list of prices, validating the list up front.
 *
 * @throws {@link Error} On an empty list, a duplicate currency, or an empty `amount`/`currency`.
 */
function toEntries(prices: readonly InflowChargePrice[]): InflowChargeEntry[] {
  if (prices.length === 0) {
    throw new Error('inflowCharges requires at least one price.');
  }

  const seen = new Set<string>();
  const entries: InflowChargeEntry[] = [];
  for (const price of prices) {
    if (price.currency.trim() === '') {
      throw new Error('inflowCharges: each price must have a non-empty currency.');
    }
    if (price.amount.trim() === '') {
      throw new Error(`inflowCharges: price for ${price.currency} must have a non-empty amount.`);
    }
    if (seen.has(price.currency)) {
      throw new Error(`inflowCharges: duplicate currency "${price.currency}" — one price per currency.`);
    }
    seen.add(price.currency);
    entries.push(['inflow/charge', { amount: price.amount, currency: price.currency }]);
  }
  return entries;
}

/**
 * Present several currencies on one route. Returns the framework-agnostic Web-fetch handler produced by `compose`: one
 * `WWW-Authenticate: Payment` challenge per price. The MPP core spec models multiple currencies as multiple challenges
 * (not one multi-currency challenge), so this repeats the `inflow/charge` method once per currency. The buyer selects
 * one challenge and pays it; `compose` matches the returned credential back to the right entry by its stable binding
 * (which includes the currency).
 *
 * This is the MPP analog of `@inflowpayai/x402-seller`'s `inflowAccepts`. It is only available on the core
 * `mppx/server` instance — the framework adapters (`mppx/express`, `mppx/hono`) intentionally expose only the
 * single-price `charge(...)` and do not expose `compose`.
 *
 * Currency _support_ is not validated here (that needs the resolved `/config`); an unsupported currency surfaces at
 * request time as `MppUnsupportedCurrencyError`, exactly as with `charge`.
 *
 * @param mppx - A core `Mppx.create({ methods: [inflow(...)] })` instance.
 * @param prices - One `{ amount, currency }` per currency to accept.
 * @returns The composed Web-fetch handler.
 * @throws {@link Error} On an empty list, a duplicate currency, or an empty `amount`/`currency`.
 */
export function inflowCharges<Handler>(mppx: InflowComposable<Handler>, prices: readonly InflowChargePrice[]): Handler {
  return mppx.compose(...toEntries(prices));
}

/**
 * Node convenience over {@link inflowCharges}: wraps the composed Web-fetch handler with `Mppx.toNodeListener` so it can
 * be mounted directly on a Node `http` server (or Express). On a 402 the challenge response is written and the listener
 * resolves `{ status: 402 }`; on a 200 the `Payment-Receipt` header is set and the caller writes the body.
 *
 * @param mppx - A core `Mppx.create({ methods: [inflow(...)] })` instance.
 * @param prices - One `{ amount, currency }` per currency to accept.
 * @returns A Node `(req, res) => Promise<...>` listener.
 * @throws {@link Error} On an empty list, a duplicate currency, or an empty `amount`/`currency`.
 */
export function inflowChargesNodeListener(
  mppx: InflowComposable<InflowFetchHandler>,
  prices: readonly InflowChargePrice[],
): ReturnType<typeof Mppx.toNodeListener> {
  return Mppx.toNodeListener(inflowCharges(mppx, prices));
}

/**
 * One subscription plan a seller offers: a recurring `amount` in `currency`, billed every `periodCount` × `periodUnit`
 * until `subscriptionExpires`. The rail is derived from the currency (subscriptions settle on `balance`, enforced
 * server-side). `externalId` is optional seller reconciliation metadata; it is not a lookup, authorization, or
 * idempotency key.
 */
export interface InflowSubscriptionPlan {
  /** Recurring decimal amount string in `currency`'s units, e.g. `'9.99'`. */
  amount: string;
  /** Currency code the recurring charge settles in (crypto → balance rail). */
  currency: string;
  /** Billing period unit. */
  periodUnit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';
  /** Number of `periodUnit`s per billing period (positive integer). */
  periodCount: number;
  /** RFC 3339 timestamp after which the subscription may no longer renew. */
  subscriptionExpires: string;
  /** Optional seller reconciliation metadata (1 to 128 non-blank characters). */
  externalId?: string;
}

/** The `compose` entry shape for the `inflow` subscription method: a `[methodKey, options]` tuple. */
type InflowSubscriptionEntry = readonly [
  'inflow/subscription',
  {
    amount: string;
    currency: string;
    periodUnit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';
    periodCount: number;
    subscriptionExpires: string;
    externalId?: string;
  },
];

/**
 * The slice of a core `mppx/server` instance {@link inflowSubscriptions} needs: its `compose(...)` over subscription
 * entries. Kept structural so the helper is generic over any `Mppx.create({ methods: [inflow.subscription(...)] })`
 * instance while staying fully typed.
 */
interface InflowSubscriptionComposable<Handler> {
  compose: (...entries: readonly InflowSubscriptionEntry[]) => Handler;
}

/**
 * Build + validate the `compose` entries for a list of subscription plans.
 *
 * @throws {@link Error} On an empty list or invalid plan terms.
 */
function toSubscriptionEntries(plans: readonly InflowSubscriptionPlan[]): InflowSubscriptionEntry[] {
  if (plans.length === 0) {
    throw new Error('inflowSubscriptions requires at least one plan.');
  }

  const entries: InflowSubscriptionEntry[] = [];
  for (const plan of plans) {
    if (plan.currency.trim() === '') {
      throw new Error('inflowSubscriptions: each plan must have a non-empty currency.');
    }
    if (plan.amount.trim() === '') {
      throw new Error(`inflowSubscriptions: plan for ${plan.currency} must have a non-empty amount.`);
    }
    if (plan.subscriptionExpires.trim() === '') {
      throw new Error(`inflowSubscriptions: plan for ${plan.currency} must have a non-empty subscriptionExpires.`);
    }
    if (!Number.isSafeInteger(plan.periodCount) || plan.periodCount < 1) {
      throw new Error(`inflowSubscriptions: plan for ${plan.currency} must have a positive safe-integer periodCount.`);
    }
    if (plan.periodUnit === 'minute' && plan.periodCount < 5) {
      throw new Error(
        `inflowSubscriptions: plan for ${plan.currency} must have a periodCount of at least 5 for minute.`,
      );
    }
    if (!/^\d+(\.\d+)?$/.test(plan.amount) || !/[1-9]/.test(plan.amount)) {
      throw new Error(`inflowSubscriptions: plan for ${plan.currency} must have a positive decimal amount.`);
    }
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(plan.subscriptionExpires) ||
      !Number.isFinite(Date.parse(plan.subscriptionExpires))
    ) {
      throw new Error(`inflowSubscriptions: plan for ${plan.currency} must have an RFC 3339 subscriptionExpires.`);
    }
    if (plan.externalId !== undefined && (plan.externalId.trim() === '' || plan.externalId.length > 128)) {
      throw new Error(`inflowSubscriptions: plan for ${plan.currency} externalId must contain 1 to 128 characters.`);
    }
    entries.push([
      'inflow/subscription',
      {
        amount: plan.amount,
        currency: plan.currency,
        periodUnit: plan.periodUnit,
        periodCount: plan.periodCount,
        subscriptionExpires: plan.subscriptionExpires,
        ...(plan.externalId !== undefined ? { externalId: plan.externalId } : {}),
      },
    ]);
  }
  return entries;
}

/**
 * Present one or more subscription plans on a route: one `WWW-Authenticate: Payment` `intent=subscription` challenge
 * per plan. The recurring analog of {@link inflowCharges}. The mppx instance must be created with the subscription
 * method registered (`Mppx.create({ methods: [inflow.subscription(...)] })`).
 *
 * @param mppx - A core `Mppx.create({ methods: [inflow.subscription(...)] })` instance.
 * @param plans - One `{ amount, currency, periodUnit, periodCount, subscriptionExpires }` per plan.
 * @returns The composed Web-fetch handler.
 * @throws {@link Error} On an invalid plan list (see {@link toSubscriptionEntries}).
 */
export function inflowSubscriptions<Handler>(
  mppx: InflowSubscriptionComposable<Handler>,
  plans: readonly InflowSubscriptionPlan[],
): Handler {
  return mppx.compose(...toSubscriptionEntries(plans));
}

/**
 * Node convenience over {@link inflowSubscriptions}: wraps the composed Web-fetch handler with `Mppx.toNodeListener`.
 *
 * @param mppx - A core `Mppx.create({ methods: [inflow.subscription(...)] })` instance.
 * @param plans - One plan per subscription offered.
 * @returns A Node `(req, res) => Promise<...>` listener.
 * @throws {@link Error} On an invalid plan list.
 */
export function inflowSubscriptionsNodeListener(
  mppx: InflowSubscriptionComposable<InflowFetchHandler>,
  plans: readonly InflowSubscriptionPlan[],
): ReturnType<typeof Mppx.toNodeListener> {
  return Mppx.toNodeListener(inflowSubscriptions(mppx, plans));
}

/**
 * The Web-fetch handler shape `Mppx.toNodeListener` accepts (and that `compose` returns), derived without naming
 * internals.
 */
type InflowFetchHandler = Parameters<typeof Mppx.toNodeListener>[0];
