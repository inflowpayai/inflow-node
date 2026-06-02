import { METHOD_INFLOW } from '@inflowpayai/mpp';
import type { MppClient, MppConfigResponse, MppCurrencyRail } from '@inflowpayai/mpp';

import type { LoadedConfig } from './types.js';

/**
 * The config client primes `GET /v1/mpp/config` once and exposes the slice the `inflow` method needs (feature flags and
 * the currency → rail map). The fetch is memoised: the first {@link InflowConfigClient.load} call performs the request;
 * subsequent calls return the same cached result. Construct it inside the `inflow` factory and share it across
 * charges.
 *
 * It mirrors `@inflowpayai/x402-seller`'s seller-client (prime-once, cache-forever) and, like it, never carries the
 * binding `secretKey` — that secret lives only on `Mppx.create`.
 */
export interface InflowConfigClient {
  /**
   * Fetch (once) and cache the PSP config.
   *
   * @returns The resolved config slice the SDK consumes.
   */
  load(): Promise<LoadedConfig>;
}

/**
 * Construct an {@link InflowConfigClient} over an existing {@link MppClient} (shared with the method's redeem path).
 * Holds a single in-flight/cached config promise.
 *
 * @param client - The shared MPP REST client.
 * @returns A memoised config client.
 */
export function createConfigClient(client: MppClient): InflowConfigClient {
  let cached: Promise<LoadedConfig> | undefined;

  async function fetchConfig(): Promise<LoadedConfig> {
    const config = await client.getConfig();
    return {
      currencyRails: extractCurrencyRails(config),
      featureFlags: config.featureFlags,
      sellerId: config.sellerId,
    };
  }

  function load(): Promise<LoadedConfig> {
    cached ??= fetchConfig();
    return cached;
  }

  return { load };
}

/**
 * Pull the `inflow` method's currency → rail capability map out of `supportedMethods`. Returns an empty map when the
 * PSP advertises no `inflow` method or no rails (so every currency fails the capability check rather than throwing
 * here).
 *
 * @param config - The fetched PSP config.
 * @returns The currency → rail map for `inflow`.
 */
function extractCurrencyRails(config: MppConfigResponse): Record<string, MppCurrencyRail> {
  const method = config.supportedMethods.find((entry) => entry.id === METHOD_INFLOW);
  return method?.methodDetails?.currencyRails ?? {};
}
