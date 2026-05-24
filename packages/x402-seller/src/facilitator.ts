import { InflowApiError, InflowHttpClient, X402_VERSION } from '@inflowpayai/x402';
import type {
  InflowPaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
  X402FacilitatorSupportedResponse,
} from '@inflowpayai/x402';
import { EXTENSION_PAYMENT_IDENTIFIER, generatePaymentId, validatePaymentId } from '@inflowpayai/x402/extensions';
import type { FacilitatorClient } from '@x402/core/server';

import type { InflowFacilitatorOptions, InflowUnauthenticatedFacilitatorOptions } from './types.js';

const SUPPORTED_PATH = '/v1/x402/supported';
const VERIFY_PATH = '/v1/x402/verify';
const SETTLE_PATH = '/v1/x402/settle';

/**
 * Spec-defined error code paired with HTTP 412 Precondition Failed when the Permit2 allowance check fails. See
 * {@link https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
 * x402 EVM exact scheme} for
 * the contract. The SDK normalises the 412 into an `isValid: false` VerifyResponse so callers see a single shape and
 * can branch on `invalidReason`.
 */
const PERMIT2_ALLOWANCE_REQUIRED_HTTP_STATUS = 412 as const;

/** TTL for the cached `getSupported()` response (milliseconds). */
const CACHE_TTL_MS = 60 * 60 * 1000;

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
 * Construct an authed InFlow facilitator. The returned object satisfies the foundation V2 `FacilitatorClient` contract
 * from `@x402/core` (`verify` / `settle` / `getSupported` only) and drops directly into the foundation middleware's
 * `facilitatorClients` array (`@x402/express`, `@x402/hono`) — first claimer of a `(scheme, network)` in declaration
 * order wins verify/settle routing.
 *
 * Seller-authed endpoints (`/v1/x402/config`, `getSignerAddresses`) live on the separate
 * {@link createInflowSellerClient} factory; this client carries the seller's API key only for `verify` / `settle` /
 * `getSupported`, where it enables server-side `payTo`-against-wallets validation.
 *
 * `getSupported()` is cached lazily in-memory for 60 minutes after the first call; concurrent callers share an
 * in-flight refresh. There is no priming step — the foundation middleware calls `getSupported()` once at
 * `x402ResourceServer.initialize()` and the cache is populated then.
 *
 * @param options - {@link InflowFacilitatorOptions}.
 * @returns A foundation `FacilitatorClient`.
 */
export function createInflowFacilitator(options: InflowFacilitatorOptions): FacilitatorClient {
  const http = new InflowHttpClient(options);
  const supportedCache: CacheEntry<X402FacilitatorSupportedResponse> = newEntry();

  return buildFacilitator(http, supportedCache);
}

/**
 * Anonymous sibling of {@link createInflowFacilitator} — same caches and contract, no `X-API-KEY` header. For
 * facilitator-only deployments (self-hosted, public-facilitator mode, test harnesses).
 */
export function createUnauthenticatedInflowFacilitator(
  options: InflowUnauthenticatedFacilitatorOptions,
): FacilitatorClient {
  const http = new InflowHttpClient({
    environment: options.environment,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  });
  const supportedCache: CacheEntry<X402FacilitatorSupportedResponse> = newEntry();

  return buildFacilitator(http, supportedCache);
}

/**
 * Internal shape that mirrors `FacilitatorClient` but uses the SDK's widened types (`network: string` instead of the
 * foundation's CAIP-2 template literal). Wire-equivalent at runtime; only the TypeScript bounds differ.
 * {@link asFacilitatorClient} re-narrows once at the boundary so the `verify` / `settle` / `getSupported` signatures
 * still appear typed at the call site.
 */
interface InflowFacilitatorShape {
  getSupported: () => Promise<X402FacilitatorSupportedResponse>;
  verify: (paymentPayload: InflowPaymentPayload, paymentRequirements: PaymentRequirements) => Promise<VerifyResponse>;
  settle: (paymentPayload: InflowPaymentPayload, paymentRequirements: PaymentRequirements) => Promise<SettleResponse>;
}

/**
 * Single, explicit cast point between the SDK's widened types and the foundation `FacilitatorClient`. Passing anything
 * other than a fully shaped `InflowFacilitatorShape` to this helper fails at compile time, so additions to
 * `FacilitatorClient` upstream surface here rather than disappearing into an `as unknown as` site.
 */
function asFacilitatorClient(client: InflowFacilitatorShape): FacilitatorClient {
  return client as unknown as FacilitatorClient;
}

/**
 * Shared implementation for the authed and anonymous factories. Caches `getSupported()` lazily with in-flight sharing;
 * verify and settle pass straight through to the seller-side facilitator endpoints.
 */
function buildFacilitator(
  http: InflowHttpClient,
  supportedCache: CacheEntry<X402FacilitatorSupportedResponse>,
): FacilitatorClient {
  async function fetchSupported(): Promise<X402FacilitatorSupportedResponse> {
    const fresh = await http.get<X402FacilitatorSupportedResponse>(SUPPORTED_PATH);
    supportedCache.value = fresh;
    supportedCache.expiresAt = Date.now() + CACHE_TTL_MS;
    return fresh;
  }

  function getSupportedCached(): Promise<X402FacilitatorSupportedResponse> {
    if (supportedCache.value !== undefined && Date.now() < supportedCache.expiresAt) {
      return Promise.resolve(supportedCache.value);
    }
    if (supportedCache.inFlight !== undefined) return supportedCache.inFlight;
    const inFlight = fetchSupported().finally(() => {
      supportedCache.inFlight = undefined;
    });
    supportedCache.inFlight = inFlight;
    return inFlight;
  }

  const shape: InflowFacilitatorShape = {
    getSupported: () => getSupportedCached(),
    async verify(paymentPayload, paymentRequirements) {
      // Transport-level retries are disabled: `/verify` and `/settle` are
      // idempotent only via the `payment-identifier` extension (server-side
      // X402PaymentIdCache). A 5xx-burst retry without an identifier could
      // re-debit or re-broadcast.
      try {
        return await http.post<VerifyResponse>(
          VERIFY_PATH,
          {
            x402Version: X402_VERSION,
            paymentPayload: ensurePaymentIdentifier(paymentPayload),
            paymentRequirements,
          },
          { retries: 0 },
        );
      } catch (err) {
        // The facilitator emits HTTP 412 with the standard VerifyResponse
        // body when Permit2 reports an allowance gap
        // (`invalidReason: PERMIT2_ALLOWANCE_REQUIRED`). The SDK normalises
        // the non-2xx into the same isValid:false VerifyResponse shape the
        // caller already handles for every other invalid case, so callers
        // get a single, branchable surface.
        if (
          err instanceof InflowApiError &&
          err.httpStatus === PERMIT2_ALLOWANCE_REQUIRED_HTTP_STATUS &&
          isVerifyResponseShape(err.body)
        ) {
          return err.body;
        }
        throw err;
      }
    },
    async settle(paymentPayload, paymentRequirements) {
      return http.post<SettleResponse>(
        SETTLE_PATH,
        {
          x402Version: X402_VERSION,
          paymentPayload: ensurePaymentIdentifier(paymentPayload),
          paymentRequirements,
        },
        { retries: 0 },
      );
    },
  };
  return asFacilitatorClient(shape);
}

/**
 * Structural check for the body the InFlow facilitator returns alongside a 412 verify response. Defensive — if the
 * runtime ever emits a different 412 body shape, the caller sees the original {@link InflowApiError} instead of a
 * misleading verify-style result.
 */
function isVerifyResponseShape(body: unknown): body is VerifyResponse {
  return typeof body === 'object' && body !== null && 'isValid' in body && 'invalidReason' in body;
}

/**
 * Returns a payload that carries a valid `payment-identifier` extension entry. If the buyer already supplied one
 * (server-signed InFlow payloads always do; foundation buyers may), it is preserved unchanged. Otherwise a fresh
 * `pay_<32-hex>` identifier is generated so settle/verify retries land in the server's idempotency cache.
 */
function ensurePaymentIdentifier(payload: InflowPaymentPayload): InflowPaymentPayload {
  const existing = payload.extensions?.[EXTENSION_PAYMENT_IDENTIFIER];
  if (existing !== undefined && existing !== null && typeof existing === 'object') {
    const { paymentId } = existing as { paymentId?: unknown };
    if (typeof paymentId === 'string' && validatePaymentId(paymentId)) {
      return payload;
    }
  }
  const paymentId = generatePaymentId();
  return {
    ...payload,
    extensions: {
      ...(payload.extensions ?? {}),
      [EXTENSION_PAYMENT_IDENTIFIER]: { paymentId },
    },
  };
}
