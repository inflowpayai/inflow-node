import { InflowHttpClient } from '@inflowpayai/x402';
import type { Environment, X402ConfigResponse, X402FacilitatorSupportedResponse } from '@inflowpayai/x402';

const CONFIG_PATH = '/v1/x402/config';
const SUPPORTED_PATH = '/v1/x402/supported';

/** TTL for cached `config()` and supported responses (milliseconds). */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Constructor options for {@link createInflowSellerClient}.
 *
 * `apiKey` is required at the type level. `/v1/x402/config` is a seller-authed endpoint — there's no facilitator-mode
 * equivalent — so an unauthenticated seller client has no useful surface to expose.
 */
export interface InflowSellerClientOptions {
  /** Selects one of the public environments. */
  environment: Environment;
  /** InFlow API key sent on every request as `X-API-KEY`. Required. */
  apiKey: string;
  /** Override the environment-derived URL. Takes precedence over `environment`. */
  baseUrl?: string;
}

/**
 * Seller-authed InFlow client. Wraps the `/v1/x402/config` and `/v1/x402/supported` endpoints and surfaces
 * signer-address discovery on top of `getSupported()`. Drives {@link inflowAccepts} and any operator- facing
 * introspection.
 *
 * Construct via {@link createInflowSellerClient}. The factory primes both caches in parallel before resolving, so
 * methods on the returned instance hit in-memory data for the lifetime of the 60-minute TTL.
 *
 * @see createInflowSellerClient
 */
export interface InflowSellerClient {
  /**
   * Fetch the seller config (assets, wallets, payment methods, sellerId). Cached for 60 minutes after the factory's
   * prime call.
   *
   * @returns The current `X402ConfigResponse` (re-exported from `@inflowpayai/x402`).
   */
  config(): Promise<X402ConfigResponse>;
  /**
   * Force a refetch of `GET /v1/x402/config` and replace the cached value.
   *
   * @returns The freshly fetched `X402ConfigResponse` (re-exported from `@inflowpayai/x402`).
   */
  refreshConfig(): Promise<X402ConfigResponse>;
  /**
   * Force a refetch of `GET /v1/x402/supported` and replace the cached value.
   *
   * @returns The freshly fetched `X402FacilitatorSupportedResponse` (re-exported from `@inflowpayai/x402`).
   */
  refreshSupported(): Promise<X402FacilitatorSupportedResponse>;
  /**
   * Signer addresses advertised by the facilitator for the given network.
   *
   * Lookup is exact-match on `network` first; if no entry exists and the input is CAIP-2 shaped
   * (`<namespace>:<reference>`), it falls back to a `<namespace>:*` wildcard key so external facilitators that follow
   * the V2 spec's wildcard form interop. Returns `[]` when nothing matches.
   *
   * @param network - CAIP-2 string (e.g. `'eip155:8453'` or `'inflow:1'`).
   * @returns The configured signer addresses, or `[]` when none match.
   */
  getSignerAddresses(network: string): Promise<readonly string[]>;
}

/**
 * State for a single cached value. Tracks the value, its expiry timestamp, and any in-flight refresh so concurrent
 * callers share a single request.
 */
interface CacheEntry<T> {
  value: T | undefined;
  expiresAt: number;
  inFlight: Promise<T> | undefined;
}

function newEntry<T>(): CacheEntry<T> {
  return { value: undefined, expiresAt: 0, inFlight: undefined };
}

/**
 * Construct an {@link InflowSellerClient}.
 *
 * The factory primes the config and `getSupported()` caches in parallel before resolving, so the first downstream call
 * ({@link inflowAccepts}, `getSignerAddresses`, etc.) is synchronous against in-memory data. Cost: one round trip at
 * startup; benefit: synchronous downstream use.
 *
 * @param options - {@link InflowSellerClientOptions}.
 * @returns A promise resolving to a primed {@link InflowSellerClient}.
 */
export async function createInflowSellerClient(options: InflowSellerClientOptions): Promise<InflowSellerClient> {
  const http = new InflowHttpClient(options);

  const configCache: CacheEntry<X402ConfigResponse> = newEntry();
  const supportedCache: CacheEntry<X402FacilitatorSupportedResponse> = newEntry();

  async function fetchConfig(): Promise<X402ConfigResponse> {
    const fresh = await http.get<X402ConfigResponse>(CONFIG_PATH);
    configCache.value = fresh;
    configCache.expiresAt = Date.now() + CACHE_TTL_MS;
    return fresh;
  }

  async function fetchSupported(): Promise<X402FacilitatorSupportedResponse> {
    const fresh = await http.get<X402FacilitatorSupportedResponse>(SUPPORTED_PATH);
    supportedCache.value = fresh;
    supportedCache.expiresAt = Date.now() + CACHE_TTL_MS;
    return fresh;
  }

  /**
   * Cache-or-fetch with in-flight sharing: while a refresh is happening, any concurrent caller awaits the same promise
   * instead of issuing a duplicate request.
   */
  function getCached<T>(entry: CacheEntry<T>, fetcher: () => Promise<T>): Promise<T> {
    if (entry.value !== undefined && Date.now() < entry.expiresAt) {
      return Promise.resolve(entry.value);
    }
    if (entry.inFlight !== undefined) return entry.inFlight;
    const inFlight = fetcher().finally(() => {
      entry.inFlight = undefined;
    });
    entry.inFlight = inFlight;
    return inFlight;
  }

  /**
   * Reissues the fetch and atomically swaps in the new value on success. The previously cached value is held until the
   * refresh resolves, so concurrent readers never see a torn cache or a forced re-fetch on transient failures.
   */
  function refresh<T>(entry: CacheEntry<T>, fetcher: () => Promise<T>): Promise<T> {
    if (entry.inFlight !== undefined) return entry.inFlight;
    const inFlight = fetcher().finally(() => {
      entry.inFlight = undefined;
    });
    entry.inFlight = inFlight;
    return inFlight;
  }

  function resolveSigners(signers: Record<string, string[]> | undefined, network: string): readonly string[] {
    if (signers === undefined) return [];
    const exact = signers[network];
    if (exact !== undefined) return exact;
    // CAIP-2 wildcard fallback: `<namespace>:*`. The input must contain ':'.
    const colonIndex = network.indexOf(':');
    if (colonIndex <= 0) return [];
    const wildcard = signers[`${network.slice(0, colonIndex)}:*`];
    return wildcard ?? [];
  }

  const client: InflowSellerClient = {
    config: () => getCached(configCache, fetchConfig),
    refreshConfig: () => refresh(configCache, fetchConfig),
    refreshSupported: () => refresh(supportedCache, fetchSupported),
    async getSignerAddresses(network: string): Promise<readonly string[]> {
      const supported = await getCached(supportedCache, fetchSupported);
      return resolveSigners(supported.signers, network);
    },
  };

  // Prime both caches in parallel so the first user-facing call is sync
  // against in-memory data.
  await Promise.all([fetchConfig(), fetchSupported()]);
  return client;
}
