import type {
  InflowAnonymousClientOptions,
  InflowBearerClientOptions,
  InflowClientOptions,
  MppCredential,
} from '@inflowpayai/mpp';

/**
 * Construction parameters for the {@link inflow} client method factory. Inherits the three auth shapes accepted by
 * `MppClient`'s constructor — `InflowClientOptions` (API key via `X-API-KEY`), `InflowAnonymousClientOptions` (no auth
 * header), or `InflowBearerClientOptions` (OAuth Bearer via a `getAccessToken` callback) — plus the polling knobs that
 * bound the pending → ready wait when the server returns `pending`. Mirrors `@inflowpayai/x402-buyer`'s
 * `SignerOptions`, so a buyer authenticated with a device-flow access token uses the same shape here as it does for
 * x402.
 */
export type InflowBuyerParameters = (InflowClientOptions | InflowAnonymousClientOptions | InflowBearerClientOptions) & {
  /**
   * Poll interval (ms) used when a `pending` response carries no `retryAfterSeconds`. The server-advertised
   * `retryAfterSeconds` always takes precedence. Defaults to 5000.
   */
  pollIntervalMs?: number;
  /**
   * Total budget (ms) for the pending → ready wait before {@link MppPaymentTimeoutError}. Defaults to 900000 (15 min),
   * matching the server-side approval expiry.
   */
  timeoutMs?: number;
};

/** Per-fulfilment overrides for the prepare → poll → cancel lifecycle. */
export interface FulfilOptions {
  /** Abort the in-flight fulfilment (breaks the poll loop and fire-and-forget cancels the backing approval). */
  signal?: AbortSignal;
  /** Override the client-level poll interval (ms) for this fulfilment. */
  pollIntervalMs?: number;
  /** Override the client-level budget (ms) for this fulfilment. */
  timeoutMs?: number;
}

/**
 * The driver behind the {@link inflow} method's `createCredential`. Owns the InFlow MPP REST client and the set of
 * in-flight polls so `cleanup()` can abort them. Not part of the public barrel beyond the {@link inflow} factory.
 *
 * @internal
 */
export interface Fulfiller {
  /**
   * Drive a parsed challenge through `POST /v1/transactions/mpp` → poll `GET /v1/transactions/{id}/mpp` and return the
   * server-produced credential when the transaction reaches `ready`.
   */
  fulfil(
    challenge: FulfilChallenge,
    options: Record<string, unknown>,
    callOptions?: FulfilOptions,
  ): Promise<MppCredential>;
  /**
   * Fire-and-forget cancel of a backing approval via `POST /v1/approvals/{approvalId}/cancel`. Never rejects on a
   * server outcome.
   */
  cancelApproval(approvalId: string): Promise<void>;
  /** Abort every in-flight fulfilment poll. Attached to the method as `cleanup()`. */
  cleanup(): void;
}

/**
 * The subset of the parsed `mppx` challenge the {@link Fulfiller} forwards to the InFlow server. `request` is the
 * decoded method-specific object (`mppx` parses the base64url-JCS blob); the buyer re-encodes it to the server's wire
 * form before forwarding.
 */
export interface FulfilChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: Record<string, unknown>;
  expires?: string;
  description?: string;
  digest?: string;
}
