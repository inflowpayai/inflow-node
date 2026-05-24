import type { Environment } from '@inflowpayai/x402';

/**
 * Constructor options for {@link createInflowFacilitator}. The authed facilitator drops directly into the foundation V2
 * middleware's `facilitatorClients` array (`@x402/express`, `@x402/hono`).
 */
export interface InflowFacilitatorOptions {
  /** Selects one of the public environments. */
  environment: Environment;
  /**
   * InFlow API key. Sent as `X-API-KEY` on every outbound `verify` / `settle` / `getSupported` request. Required at the
   * type level so a typo or env-var omission that leaves `apiKey` undefined can't silently degrade an authed deployment
   * to facilitator-mode — sellers who want the authless path pick {@link createUnauthenticatedInflowFacilitator}
   * explicitly.
   */
  apiKey: string;
  /** Override the environment-derived URL. Takes precedence over `environment`. */
  baseUrl?: string;
}

/**
 * Constructor options for {@link createUnauthenticatedInflowFacilitator}.
 *
 * The unauthenticated factory is the explicit escape hatch for facilitator-only deployments (self-hosted,
 * public-facilitator mode, test harnesses) that don't have a seller account. Sends no `X-API-KEY` header on outbound
 * `verify` / `settle` / `getSupported` requests.
 */
export interface InflowUnauthenticatedFacilitatorOptions {
  /** Selects one of the public environments. */
  environment: Environment;
  /** Override the environment-derived URL. Takes precedence over `environment`. */
  baseUrl?: string;
}
