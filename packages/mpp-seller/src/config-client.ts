import { METHOD_INFLOW } from '@inflowpayai/mpp';
import type { MppClient, MppConfigResponse, MppCurrencyRail, MppIntentCurrencyRails } from '@inflowpayai/mpp';

import type { LoadedConfig } from './types.js';

/**
 * Concurrent loads share one configuration request. A successful result stays cached for the lifetime of the client; a
 * failed request is discarded so a later load can retry. The binding `secretKey` belongs to `Mppx.create`, not config.
 */
export interface InflowConfigClient {
  /**
   * Load the PSP config, reusing an in-flight request or a successful cached result.
   *
   * @returns The resolved config slice the SDK consumes.
   */
  load(): Promise<LoadedConfig>;
}

/**
 * Construct an {@link InflowConfigClient} over an existing {@link MppClient} (shared with the method's credential
 * lifecycle calls). Holds a single in-flight/cached config promise.
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
      intentCurrencyRails: extractIntentCurrencyRails(config),
      featureFlags: config.featureFlags,
      sellerId: config.sellerId,
    };
  }

  function load(): Promise<LoadedConfig> {
    cached ??= fetchConfig().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
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

function extractIntentCurrencyRails(config: MppConfigResponse): MppIntentCurrencyRails {
  const method = config.supportedMethods.find((entry) => entry.id === METHOD_INFLOW);
  return method?.methodDetails?.['intentCurrencyRails'] ?? {};
}
