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
 * The Web-fetch handler shape `Mppx.toNodeListener` accepts (and that `compose` returns), derived without naming
 * internals.
 */
type InflowFetchHandler = Parameters<typeof Mppx.toNodeListener>[0];
