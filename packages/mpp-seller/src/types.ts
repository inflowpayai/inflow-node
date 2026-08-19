// Public parameter and capability types for `@inflowpayai/mpp-seller`. Interfaces only — no runtime — so this module is
// excluded from coverage (see vitest.config.ts).

import type {
  charge as inflowCharge,
  CurrencyCode,
  Environment,
  MppCurrencyRail,
  MppFeatureFlags,
  MppIntentCurrencyRails,
  tempoCharge,
} from '@inflowpayai/mpp';
import type { TempoMethodDetails } from '@inflowpayai/mpp';
import type { Method } from 'mppx';

/**
 * Constructor parameters for the seller-side {@link inflow} method factory.
 *
 * Note the absence of a `secretKey`: the challenge-binding HMAC secret is **not** a method parameter. It is owned by
 * the foundation SDK and supplied to `Mppx.create({ secretKey })` (or the `MPP_SECRET_KEY` environment variable). It is
 * never the API key, and is never returned by `GET /v1/mpp/config`.
 */
export interface InflowSellerParameters {
  /** InFlow API key, sent as `X-API-KEY` on config, validation, and broadcast calls. */
  apiKey: string;
  /** Selects one of the public environments. Defaults to `'production'`. */
  environment?: Environment;
  /** Override the environment-derived API base URL. Takes precedence over `environment`. */
  baseUrl?: string;
  /** Default charge currency, applied as an mppx request default so `charge({ amount })` need not repeat it per call. */
  currency?: CurrencyCode;
  /** Per-request timeout (milliseconds) for config and credential lifecycle calls. */
  timeoutMs?: number;
  /** Optional `fetch` implementation. Defaults to `globalThis.fetch`. Must conform to the WHATWG fetch API. */
  fetch?: typeof fetch;
  /** Decides whether a configured InFlow offer is available for a composed HTTP request. */
  canOffer?: Method.CanOfferFn<typeof inflowCharge>;
}

/** Constructor parameters for the seller-side Tempo method factory. */
export interface TempoSellerParameters {
  /** InFlow API key, sent as `X-API-KEY` on validation and broadcast calls. */
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
  /** Per-request timeout (milliseconds) for credential lifecycle calls. */
  timeoutMs?: number;
  /** Optional `fetch` implementation. Defaults to `globalThis.fetch`. Must conform to the WHATWG fetch API. */
  fetch?: typeof fetch;
  /** Decides whether a configured Tempo offer is available for a composed HTTP request. */
  canOffer?: Method.CanOfferFn<typeof tempoCharge>;
}

/**
 * The slice of `GET /v1/mpp/config` the `inflow` method consumes, resolved once at init by the
 * {@link InflowConfigClient}. Realm and challenge expiry are deliberately absent: `mppx` owns both (realm via
 * `Mppx.create`/`MPP_REALM`, expiry via the per-charge `expires` option, defaulting to 5 minutes), so the method never
 * reads them. The binding `secretKey` is likewise never carried in config.
 */
export interface LoadedConfig {
  /** Compatibility capabilities for servers that do not advertise an intent matrix. */
  currencyRails: Record<string, MppCurrencyRail>;
  /** Intent and currency capabilities. Each currency may offer multiple settlement rails. */
  intentCurrencyRails: MppIntentCurrencyRails;
  /** Bootstrap feature flags gating the `Idempotency-Key` header on broadcast. */
  featureFlags: MppFeatureFlags;
  /** The authenticated seller's user id, used as the `recipient` on every minted challenge. */
  sellerId: string;
}
