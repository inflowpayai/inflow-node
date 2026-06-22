/**
 * HTTP header names used by the MPP wire protocol. Mirrors the server's `MppHeaders`. Emitted verbatim on the write
 * path; read via {@link readHeader} (case-insensitive).
 */
export const HEADERS = {
  AUTHORIZATION: 'Authorization',
  CACHE_CONTROL: 'Cache-Control',
  IDEMPOTENCY_KEY: 'Idempotency-Key',
  PAYMENT_RECEIPT: 'Payment-Receipt',
  RETRY_AFTER: 'Retry-After',
  WWW_AUTHENTICATE: 'WWW-Authenticate',
} as const;

/**
 * `Cache-Control` directives the protocol prescribes. `no-store` on 402 / problem-shape responses (challenges and
 * failures must never be cached); `private` on receipt-bearing responses.
 */
export const CACHE_CONTROL = {
  NO_STORE: 'no-store',
  PRIVATE: 'private',
} as const;

/**
 * Auth-scheme token carried in `WWW-Authenticate` and `Authorization`. The only valid scheme for MPP. Matched
 * case-insensitively on parse (RFC 7235) and emitted with this exact casing on render.
 */
export const SCHEME_PAYMENT = 'Payment' as const;

/** Stable identifier of the `inflow` payment method — the `method` auth-param value and `MppMethodId` label. */
export const METHOD_INFLOW = 'inflow' as const;

/** Stable identifier of the Tempo payment method — the `method` auth-param value and `MppMethodId` label. */
export const METHOD_TEMPO = 'tempo' as const;

/** The `charge` intent — the only intent this SDK implements today and the `MppIntent` label. */
export const INTENT_CHARGE = 'charge' as const;

/**
 * Base URI for MPP problem-type identifiers. Every `MppProblemDetail.type` is this prefix followed by a slug
 * (`invalid-challenge`, `verification-failed`, …). Mirrors the server's `MppProblemDetail` factory.
 */
export const PROBLEM_TYPE_BASE = 'https://paymentauth.org/problems/' as const;

/** Known `MppProblemDetail.type` slugs, appended to {@link PROBLEM_TYPE_BASE}. Mirrors the server's factory variants. */
export const PROBLEM_TYPES = {
  INVALID_CHALLENGE: `${PROBLEM_TYPE_BASE}invalid-challenge`,
  MALFORMED_CREDENTIAL: `${PROBLEM_TYPE_BASE}malformed-credential`,
  METHOD_UNSUPPORTED: `${PROBLEM_TYPE_BASE}method-unsupported`,
  PAYMENT_EXPIRED: `${PROBLEM_TYPE_BASE}payment-expired`,
  PAYMENT_INSUFFICIENT: `${PROBLEM_TYPE_BASE}payment-insufficient`,
  PAYMENT_REQUIRED: `${PROBLEM_TYPE_BASE}payment-required`,
  SETTLEMENT_UNAVAILABLE: `${PROBLEM_TYPE_BASE}settlement-unavailable`,
  VERIFICATION_FAILED: `${PROBLEM_TYPE_BASE}verification-failed`,
} as const;

/** InFlow MPP REST endpoint paths (relative to the API base URL). Consumed by {@link MppClient}. */
export const ENDPOINTS = {
  /** Seller: bootstrap config the SDK caches on init. Never returns the HMAC secret. */
  CONFIG: '/v1/mpp/config',
  /** Seller: verify the payment, claim the single-use slot (keyed on `transactionId`), and settle. */
  REDEEM: '/v1/mpp/redeem',
  /** Buyer: fulfil a challenge. Returns `ready` (credential) or `pending`. */
  TRANSACTIONS: '/v1/transactions/mpp',
  /** Buyer: the methods/intents/rails/currencies the authenticated buyer can pay with. */
  SUPPORTED: '/v1/transactions/mpp-supported',
} as const;

/**
 * Key of the server-minted correlation id carried inside `MppCredential.payload`. The server stamps this at initiate
 * and reads it back on redeem to correlate and settle; redemption is not HMAC-bound. Exported so seller/buyer code
 * reads/writes the payload key from one source of truth rather than a string literal.
 */
export const CREDENTIAL_TRANSACTION_ID = 'transactionId' as const;

/**
 * Build the buyer poll path for an in-flight MPP transaction: `GET /v1/transactions/{id}/mpp`.
 *
 * @param transactionId - The transaction UUID returned by `POST /v1/transactions/mpp`.
 * @returns The path (relative to the API base URL) for polling that transaction's MPP state.
 */
export function transactionPath(transactionId: string): string {
  return `/v1/transactions/${transactionId}/mpp`;
}

/**
 * Header bag accepted by {@link readHeader}. Covers WHATWG `Headers`, Node's `IncomingHttpHeaders`-style records (where
 * values may be string arrays or undefined), and plain string-valued records.
 */
export type HeaderBag = Headers | Record<string, string | readonly string[] | undefined>;

/**
 * Read a single header value case-insensitively. Returns `undefined` when the header is absent. For Node-style headers
 * whose value is an array, returns the first element.
 *
 * @param headers - The header bag to read from.
 * @param name - The header name. Matched case-insensitively against the keys in `headers`.
 * @returns The header value, or `undefined` if missing.
 */
export function readHeader(headers: HeaderBag, name: string): string | undefined {
  const target = name.toLowerCase();
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const record = headers as Record<string, string | readonly string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== target) continue;
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    return value[0];
  }
  return undefined;
}

/**
 * Read every value for a header case-insensitively, flattening Node-style array values. Used for parsing multiple
 * `WWW-Authenticate: Payment` challenge headers off a single 402 response.
 *
 * @param headers - The header bag to read from.
 * @param name - The header name. Matched case-insensitively.
 * @returns All values for the header in encounter order; empty when the header is absent.
 */
export function readHeaderAll(headers: HeaderBag, name: string): string[] {
  const target = name.toLowerCase();
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    // `Headers.getSetCookie` aside, WHATWG joins repeated headers with ", "; `WWW-Authenticate` challenges are split by
    // the caller via `parseChallengeHeaders`, so a single joined value is returned here as one element.
    const joined = headers.get(name);
    return joined === null ? [] : [joined];
  }
  const out: string[] = [];
  const record = headers as Record<string, string | readonly string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== target) continue;
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value === 'string') out.push(value);
    else out.push(...value);
  }
  return out;
}
