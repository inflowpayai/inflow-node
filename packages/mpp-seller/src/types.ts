// Public parameter and capability types for `@inflowpayai/mpp-seller`. Interfaces only — no runtime — so this module is
// excluded from coverage (see vitest.config.ts).

import type { CurrencyCode, Environment, MppCurrencyRail, MppFeatureFlags } from '@inflowpayai/mpp';
import type { TempoMethodDetails } from '@inflowpayai/mpp';

/**
 * Constructor parameters for the seller-side {@link inflow} method factory.
 *
 * Note the absence of a `secretKey`: the challenge-binding HMAC secret is **not** a method parameter. It is owned by
 * the foundation SDK and supplied to `Mppx.create({ secretKey })` (or the `MPP_SECRET_KEY` environment variable). It is
 * never the API key, and is never returned by `GET /v1/mpp/config`.
 */
export interface InflowSellerParameters {
  /** InFlow API key, sent as `X-API-KEY` on the `GET /v1/mpp/config` and `POST /v1/mpp/redeem` calls. */
  apiKey: string;
  /** Selects one of the public environments. Defaults to `'production'`. */
  environment?: Environment;
  /** Override the environment-derived API base URL. Takes precedence over `environment`. */
  baseUrl?: string;
  /** Default charge currency, applied as an mppx request default so `charge({ amount })` need not repeat it per call. */
  currency?: CurrencyCode;
  /** Per-request timeout (milliseconds) for the config + redeem calls. Defaults to the core client's 30 000. */
  timeoutMs?: number;
  /** Optional `fetch` implementation. Defaults to `globalThis.fetch`. Must conform to the WHATWG fetch API. */
  fetch?: typeof fetch;
}

/** Constructor parameters for the seller-side Tempo method factory. */
export interface TempoSellerParameters {
  /** InFlow API key, sent as `X-API-KEY` on `POST /v1/mpp/redeem`. */
  apiKey: string;
  /** Selects one of the public environments. Defaults to `'production'`. */
  environment?: Environment;
  /** Override the environment-derived API base URL. Takes precedence over `environment`. */
  baseUrl?: string;
  /** TIP-20 token address used as the default challenge currency. */
  currency: string;
  /** Tempo address that receives the primary transfer. */
  recipient: string;
  /** Default Tempo method details stamped onto challenges. */
  methodDetails?: TempoMethodDetails;
  /** Per-request timeout (milliseconds) for redeem calls. Defaults to the core client's 30 000. */
  timeoutMs?: number;
  /** Optional `fetch` implementation. Defaults to `globalThis.fetch`. Must conform to the WHATWG fetch API. */
  fetch?: typeof fetch;
}

/**
 * The slice of `GET /v1/mpp/config` the `inflow` method consumes, resolved once at init by the
 * {@link InflowConfigClient}. Realm and challenge expiry are deliberately absent: `mppx` owns both (realm via
 * `Mppx.create`/`MPP_REALM`, expiry via the per-charge `expires` option, defaulting to 5 minutes), so the method never
 * reads them. The binding `secretKey` is likewise never carried in config.
 */
export interface LoadedConfig {
  /**
   * Currency → rail capability for the `inflow` method (from the method config's `methodDetails.currencyRails`). The
   * SDK derives a charge's rail from its currency via this map: crypto → `balance`, fiat → `instrument`. A currency
   * absent here cannot be charged via `inflow`.
   */
  currencyRails: Record<string, MppCurrencyRail>;
  /** Bootstrap feature flags gating the `Idempotency-Key` header on redeem. */
  featureFlags: MppFeatureFlags;
  /** The authenticated seller's user id, used as the `recipient` on every minted challenge. */
  sellerId: string;
}
