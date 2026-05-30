import { ENDPOINTS, HEADERS, readHeader, transactionPath } from './constants.js';
import type { Environment } from './environment.js';
import { resolveBaseUrl } from './environment.js';
import { InflowApiError } from './errors.js';
import type {
  MppConfigResponse,
  MppProblemDetail,
  MppRedeemRequest,
  MppRedeemResponse,
  MppSupportedResponse,
  MppTransactionRequest,
  MppTransactionResponse,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const REQUEST_ID_HEADER = 'x-request-id';
const SDK_USER_AGENT = '@inflowpayai/mpp (node)';

/**
 * Sentinel object passed to `AbortController.abort()` when the SDK-internal timeout fires. Identity-compared in
 * {@link isRetryableNetworkError} / {@link buildNetworkError} to distinguish a timeout from caller-driven aborts and
 * arbitrary network failures, without relying on string matching the `.message`.
 */
const TIMEOUT_REASON: { readonly inflowTimeout: true } = Object.freeze({ inflowTimeout: true });

/** Options accepted by {@link InflowHttpClient}'s constructor when authenticating with an InFlow API key. */
export interface InflowClientOptions {
  /** InFlow API key sent on every request as `X-API-KEY`. */
  apiKey: string;
  /** Selects one of the public environments. Defaults to `'production'`. */
  environment?: Environment;
  /** Override the environment-derived URL. Takes precedence over `environment`. */
  baseUrl?: string;
  /** Per-request timeout, milliseconds. Defaults to 30 000. On expiry the request aborts with `code: 'TIMEOUT'`. */
  timeoutMs?: number;
  /** Optional `fetch` implementation. Defaults to `globalThis.fetch`. Must conform to the WHATWG fetch API. */
  fetch?: typeof fetch;
}

/**
 * Options accepted by {@link InflowHttpClient} when constructed without auth. Sends no `X-API-KEY` header. Used by
 * callers that hit only unauthenticated routes or inject auth via `RequestOptions.headers`.
 */
export interface InflowAnonymousClientOptions {
  /** Marker field — must be omitted or `undefined`. */
  apiKey?: undefined;
  /** Selects one of the public environments. Defaults to `'production'`. */
  environment?: Environment;
  /** Override the environment-derived URL. Takes precedence over `environment`. */
  baseUrl?: string;
  /** Per-request timeout, milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
  /** Optional `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * Options for the HTTP client when authenticating with a Bearer token instead of an API key. Used by callers that hold
 * OAuth-issued access tokens (for example the InFlow CLI's device-flow client). Sends `Authorization: Bearer <token>`
 * on every request; `X-API-KEY` is never sent in this mode.
 */
export interface InflowBearerClientOptions {
  /** Marker field — must be omitted or `undefined`. Mutually exclusive with `getAccessToken`. */
  apiKey?: undefined;
  /**
   * Invoked once per HTTP attempt (a 5xx retry re-invokes it, picking up a freshly-refreshed token). Returns the access
   * token to send as `Authorization: Bearer <token>`. Errors thrown here propagate verbatim and bypass the retry loop.
   */
  getAccessToken: () => Promise<string>;
  /** Selects one of the public environments. Defaults to `'production'`. */
  environment?: Environment;
  /** Override the environment-derived URL. Takes precedence over `environment`. */
  baseUrl?: string;
  /** Per-request timeout, milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
  /** Optional `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/** Per-call overrides accepted by {@link InflowHttpClient}'s request methods. */
export interface RequestOptions {
  /**
   * Maximum retry attempts on transient failures (429, 502, 503, 504, network errors). Capped at 3. Pass `0` to
   * disable.
   */
  retries?: number;
  /** Override the client-level `timeoutMs` for this call. */
  timeoutMs?: number;
  /** Additional headers merged on top of the SDK's standard headers. */
  headers?: Record<string, string>;
  /** AbortSignal for caller-driven cancellation. Composes with the request-internal timeout signal. */
  signal?: AbortSignal;
}

interface ParsedResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * HTTP transport used by {@link MppClient} (and reusable by the buyer/seller packages) to talk to the InFlow API.
 * Carries auth-header injection (`X-API-KEY`, `Authorization: Bearer` via a per-attempt `getAccessToken`, or none),
 * retry on transient statuses (429, 502, 503, 504) with capped exponential backoff, request timeout, JSON parsing, and
 * error mapping into {@link InflowApiError}. Construct one per `(auth, environment)` pair and share it.
 *
 * Mirrors `@inflowpayai/x402`'s `InflowHttpClient` (same auth modes, env names, and base URLs) so a consumer of both
 * products configures them identically.
 */
export class InflowHttpClient {
  /** Resolved base URL (no trailing slash). */
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly getAccessToken: (() => Promise<string>) | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  /**
   * @param options - {@link InflowClientOptions}, {@link InflowAnonymousClientOptions}, or
   *   {@link InflowBearerClientOptions}. The authed form requires a non-empty `apiKey`; the anonymous form omits it; the
   *   bearer form supplies an async `getAccessToken` invoked once per attempt.
   * @throws {Error} When `apiKey` is present but empty, when `apiKey` and `getAccessToken` are both set, or when
   *   `getAccessToken` is set but not a function.
   */
  constructor(options: InflowClientOptions);
  constructor(options: InflowAnonymousClientOptions);
  constructor(options: InflowBearerClientOptions);
  constructor(options: InflowClientOptions | InflowAnonymousClientOptions | InflowBearerClientOptions);
  constructor(options: InflowClientOptions | InflowAnonymousClientOptions | InflowBearerClientOptions) {
    if (options.apiKey !== undefined) {
      if (typeof options.apiKey !== 'string') {
        throw new Error('InflowHttpClient: `apiKey` must be a non-empty string when provided.');
      }
      const trimmed = options.apiKey.trim();
      if (trimmed.length === 0) {
        throw new Error('InflowHttpClient: `apiKey` must be a non-empty string when provided.');
      }
      this.apiKey = trimmed;
    } else {
      this.apiKey = undefined;
    }

    // boundary read — runtime narrows the discriminated union
    const bearerProvider = (options as InflowBearerClientOptions).getAccessToken;
    if (bearerProvider !== undefined) {
      if (this.apiKey !== undefined) {
        throw new Error('InflowHttpClient: `apiKey` and `getAccessToken` are mutually exclusive.');
      }
      if (typeof bearerProvider !== 'function') {
        throw new Error('InflowHttpClient: `getAccessToken` must be a function when provided.');
      }
      this.getAccessToken = bearerProvider;
    } else {
      this.getAccessToken = undefined;
    }

    this.baseUrl = resolveBaseUrl({
      ...(options.environment !== undefined ? { environment: options.environment } : {}),
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    });
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const f = options.fetch ?? globalThis.fetch;
    this.fetchImpl = f.bind(globalThis);
  }

  /**
   * Issue a `GET` to `path` (relative to {@link InflowHttpClient.baseUrl}) and parse the JSON body.
   *
   * @typeParam T - Expected shape of the parsed body. Not validated at runtime; callers narrow.
   * @param path - Path including leading slash.
   * @param options - Per-call overrides.
   * @returns Parsed JSON body cast to `T`.
   * @throws {@link InflowApiError} On any non-2xx response or terminal network error.
   */
  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  /**
   * Issue a `POST` to `path` with a JSON body and parse the JSON response.
   *
   * @typeParam T - Expected shape of the parsed body.
   * @param path - Path including leading slash.
   * @param body - Value serialized via `JSON.stringify`. Pass `undefined` to send an empty body.
   * @param options - Per-call overrides.
   * @returns Parsed JSON body cast to `T`.
   * @throws {@link InflowApiError} On any non-2xx response or terminal network error.
   */
  async post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  /**
   * Lower-level entry point. Prefer {@link InflowHttpClient.get} / {@link InflowHttpClient.post}.
   *
   * @typeParam T - Expected shape of the parsed body.
   * @param method - HTTP verb.
   * @param path - Path including leading slash.
   * @param body - Optional value serialized via `JSON.stringify`.
   * @param options - Per-call overrides.
   * @returns Parsed JSON body cast to `T`.
   * @throws {@link InflowApiError} On any non-2xx response or terminal network error.
   */
  async request<T>(method: string, path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const maxRetries = Math.min(options.retries ?? MAX_RETRIES, MAX_RETRIES);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    for (let attempt = 0; ; attempt += 1) {
      // Build per-attempt auth headers OUTSIDE the network try/catch: a rejected `getAccessToken` propagates verbatim,
      // never enters the retry path, and is never wrapped in InflowApiError. Re-invoked per attempt so a 5xx retry
      // picks up a freshly-refreshed bearer token.
      const authHeaders = await this.buildAuthHeaders();
      try {
        const response = await this.sendOnce(
          method,
          url,
          body,
          options.headers,
          options.signal,
          timeoutMs,
          authHeaders,
        );
        if (response.status >= 200 && response.status < 300) {
          return response.body as T;
        }
        const error = buildApiError(path, response);
        if (RETRY_STATUSES.has(response.status) && attempt < maxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }
        throw error;
      } catch (err) {
        if (err instanceof InflowApiError) throw err;
        if (isRetryableNetworkError(err) && attempt < maxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }
        throw buildNetworkError(path, err);
      }
    }
  }

  private async buildAuthHeaders(): Promise<Record<string, string>> {
    if (this.apiKey !== undefined) {
      return { 'X-API-KEY': this.apiKey };
    }
    if (this.getAccessToken !== undefined) {
      const token = await this.getAccessToken();
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('InflowHttpClient: `getAccessToken` resolved to a non-string or empty value.');
      }
      return { Authorization: `Bearer ${token}` };
    }
    return {};
  }

  private async sendOnce(
    method: string,
    url: string,
    body: unknown,
    extraHeaders: Record<string, string> | undefined,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
    authHeaders: Record<string, string>,
  ): Promise<ParsedResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(TIMEOUT_REASON), timeoutMs);
    const onAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const headers: Record<string, string> = {
        ...authHeaders,
        Accept: 'application/json',
        'User-Agent': SDK_USER_AGENT,
        ...(extraHeaders ?? {}),
      };
      let serialized: string | undefined;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        serialized = JSON.stringify(body);
      }
      const response = await this.fetchImpl(url, {
        method,
        headers,
        ...(serialized !== undefined ? { body: serialized } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = parseJsonOrText(text, response.headers.get('content-type'));
      return { status: response.status, headers: response.headers, body: parsed };
    } finally {
      clearTimeout(timeoutId);
      if (callerSignal !== undefined) callerSignal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Parse a response body as JSON when the content-type says so (or it looks like JSON), else return the raw text.
 *
 * @param text - The raw response text.
 * @param contentType - The response `Content-Type`, or `null`.
 * @returns The parsed JSON value, the raw text, or `undefined` for an empty body.
 */
function parseJsonOrText(text: string, contentType: string | null): unknown {
  if (text.length === 0) return undefined;
  if (contentType !== null && contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * Build an {@link InflowApiError} from a non-2xx response, lifting an RFC 9457 problem body when present.
 *
 * @param path - The endpoint path that failed.
 * @param response - The parsed response.
 * @returns The composed error.
 */
function buildApiError(path: string, response: ParsedResponse): InflowApiError {
  const requestId = readHeader(response.headers, REQUEST_ID_HEADER);
  const code = extractCode(response.body);
  const problem = extractProblem(response.body);
  return InflowApiError.from({
    code,
    httpStatus: response.status,
    endpoint: path,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(problem !== undefined ? { problem } : {}),
    body: response.body,
    headers: response.headers,
  });
}

/**
 * Build an {@link InflowApiError} for a transport-level failure (timeout or network error).
 *
 * @param path - The endpoint path that failed.
 * @param cause - The underlying error.
 * @returns The composed error with `httpStatus: 0`.
 */
function buildNetworkError(path: string, cause: unknown): InflowApiError {
  const isTimeout = isTimeoutReason(cause);
  const reason = isTimeout ? 'request timed out' : cause instanceof Error ? cause.message : String(cause);
  return new InflowApiError(`${path}: network error — ${reason}`, {
    code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
    httpStatus: 0,
    endpoint: path,
    cause,
  });
}

/**
 * Identity check for the internal timeout sentinel, looking at the raw `cause` and at `err.cause` when the runtime
 * wrapped the abort reason in an `AbortError`.
 *
 * @param value - The error or abort reason to inspect.
 * @returns Whether the value originated from the SDK-internal timeout.
 */
function isTimeoutReason(value: unknown): boolean {
  if (value === TIMEOUT_REASON) return true;
  if (typeof value === 'object' && value !== null && 'cause' in value) {
    if (value.cause === TIMEOUT_REASON) return true;
  }
  return false;
}

/**
 * Extract an application error code from a response body.
 *
 * @param body - The parsed response body.
 * @returns The body's `code` string, or `'UNEXPECTED_ERROR'`.
 */
function extractCode(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'code' in body) {
    const raw = body.code;
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return 'UNEXPECTED_ERROR';
}

/**
 * Extract an RFC 9457 problem detail from a response body, when it carries the required
 * `type`/`title`/`status`/`detail` shape.
 *
 * @param body - The parsed response body.
 * @returns The problem detail, or `undefined`.
 */
function extractProblem(body: unknown): MppProblemDetail | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const source = 'problem' in body ? body.problem : body;
  if (source === null || typeof source !== 'object') return undefined;
  const candidate = source as Record<string, unknown>;
  const { type, title, status, detail, extensions } = candidate;
  if (
    typeof type === 'string' &&
    typeof title === 'string' &&
    typeof status === 'number' &&
    typeof detail === 'string'
  ) {
    const problem: MppProblemDetail = { type, title, status, detail };
    if (extensions !== null && typeof extensions === 'object') {
      problem.extensions = extensions as Record<string, unknown>;
    }
    return problem;
  }
  return undefined;
}

/**
 * Whether a thrown transport error is worth retrying. Timeouts and connection failures are; a caller-driven abort is
 * not (identity-compared against the timeout sentinel rather than matched on `.message`).
 *
 * @param err - The thrown error.
 * @returns Whether the request should be retried.
 */
function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') {
    return isTimeoutReason(err);
  }
  return true;
}

/**
 * Exponential backoff with jitter: 200 ms, 400 ms, 800 ms plus up to 25% jitter so concurrent callers desynchronise.
 *
 * @param attempt - Zero-based attempt index.
 * @returns Delay in milliseconds before the next attempt.
 */
function backoffMs(attempt: number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * (base / 4));
  return base + jitter;
}

/**
 * Promise-based delay.
 *
 * @param ms - Milliseconds to wait.
 * @returns A promise that resolves after `ms`.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-call overrides for the mutating {@link MppClient} routes, adding `Idempotency-Key` support. */
export interface MppRequestOptions extends RequestOptions {
  /**
   * Value for the `Idempotency-Key` header, honored by the server on `POST /v1/mpp/redeem` (and transactions, where
   * applicable) when `featureFlags.idempotencyKeyEnabled` is set. Replays the original outcome instead of
   * re-executing.
   */
  idempotencyKey?: string;
}

/**
 * Merge an optional `Idempotency-Key` into a request's headers without mutating the caller's options.
 *
 * @param options - The caller's per-call options.
 * @returns A {@link RequestOptions} with the idempotency header merged in when present.
 */
function withIdempotency(options: MppRequestOptions): RequestOptions {
  const { idempotencyKey, ...rest } = options;
  if (idempotencyKey === undefined) return rest;
  return { ...rest, headers: { ...(rest.headers ?? {}), [HEADERS.IDEMPOTENCY_KEY]: idempotencyKey } };
}

/**
 * Typed client for the InFlow MPP REST endpoints. Wraps an {@link InflowHttpClient} and exposes one method per route,
 * returning the DTOs from `types.ts` and throwing {@link InflowApiError} on failure. It carries no client- or
 * server-specific orchestration (no challenge minting logic, no polling loop) — just the request primitives the
 * `@inflowpayai/mpp-buyer` and `@inflowpayai/mpp-seller` packages compose on top of.
 */
export class MppClient {
  /** The underlying transport. Exposed so callers can reuse it for non-MPP InFlow routes. */
  readonly http: InflowHttpClient;

  /** @param options - Auth + environment options, or a pre-built {@link InflowHttpClient} to reuse an existing transport. */
  constructor(
    options: InflowClientOptions | InflowAnonymousClientOptions | InflowBearerClientOptions | InflowHttpClient,
  ) {
    this.http = options instanceof InflowHttpClient ? options : new InflowHttpClient(options);
  }

  /**
   * Seller: fetch the PSP bootstrap config (`GET /v1/mpp/config`). The HMAC secret is never returned.
   *
   * @param options - Per-call overrides.
   * @returns The PSP config the SDK caches on init.
   */
  async getConfig(options: RequestOptions = {}): Promise<MppConfigResponse> {
    return this.http.get<MppConfigResponse>(ENDPOINTS.CONFIG, options);
  }

  /**
   * Seller: verify the payment, claim the single-use slot (keyed on `transactionId`), and settle (`POST
   * /v1/mpp/redeem`). The server correlates by the credential's `transactionId`; redemption is not HMAC-bound. Always
   * returns HTTP 200; inspect `receipt`/`receiptHeader` (success) vs `problem` (failure) on the result.
   *
   * @param body - The credential to redeem.
   * @param options - Per-call overrides, including an optional `Idempotency-Key`.
   * @returns The redemption result (receipt on success, problem on failure).
   */
  async redeem(body: MppRedeemRequest, options: MppRequestOptions = {}): Promise<MppRedeemResponse> {
    return this.http.post<MppRedeemResponse>(ENDPOINTS.REDEEM, body, withIdempotency(options));
  }

  /**
   * Buyer: fulfil a challenge (`POST /v1/transactions/mpp`). Returns `ready` (credential available) for synchronous
   * methods, or `pending` (poll {@link MppClient.getTransaction}) for asynchronous ones.
   *
   * @param body - The parsed challenge plus method-specific options.
   * @param options - Per-call overrides.
   * @returns The transaction state.
   */
  async createTransaction(body: MppTransactionRequest, options: RequestOptions = {}): Promise<MppTransactionResponse> {
    return this.http.post<MppTransactionResponse>(ENDPOINTS.TRANSACTIONS, body, options);
  }

  /**
   * Buyer: poll the state of an in-flight transaction (`GET /v1/transactions/{id}/mpp`) until it flips to `ready`,
   * `failed`, or `expired`.
   *
   * @param transactionId - The transaction UUID from {@link MppClient.createTransaction}.
   * @param options - Per-call overrides.
   * @returns The current transaction state.
   */
  async getTransaction(transactionId: string, options: RequestOptions = {}): Promise<MppTransactionResponse> {
    return this.http.get<MppTransactionResponse>(transactionPath(transactionId), options);
  }

  /**
   * Buyer: the methods/intents/rails/currencies the authenticated buyer can pay with (`GET
   * /v1/transactions/mpp-supported`). Buyers call this to filter a seller's `WWW-Authenticate: Payment` challenges down
   * to options they can fulfil.
   *
   * @param options - Per-call overrides.
   * @returns The buyer's supported kinds.
   */
  async getSupported(options: RequestOptions = {}): Promise<MppSupportedResponse> {
    return this.http.get<MppSupportedResponse>(ENDPOINTS.SUPPORTED, options);
  }
}
