import { readHeader } from './constants.js';
import type { Environment } from './environment.js';
import { resolveBaseUrl } from './environment.js';
import { InflowApiError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const REQUEST_ID_HEADER = 'x-request-id';
const SDK_USER_AGENT = '@inflowpayai/x402 (node)';

/**
 * Sentinel object passed to `AbortController.abort()` when the SDK-internal timeout fires. Identity-compared in
 * {@link isRetryableNetworkError} and {@link buildNetworkError} to distinguish a timeout from caller-driven aborts and
 * arbitrary network failures, without relying on string matching the `.message`.
 */
const TIMEOUT_REASON: { readonly inflowTimeout: true } = Object.freeze({ inflowTimeout: true });

/**
 * Options accepted by {@link InflowHttpClient}'s constructor and shared by higher-level facilitator and signer clients
 * in the seller and buyer packages.
 */
export interface InflowClientOptions {
  /** InFlow API key sent on every request as `X-API-KEY`. */
  apiKey: string;
  /** Selects one of the public environments. Defaults to `'production'`. */
  environment?: Environment;
  /** Override the environment-derived URL. Takes precedence over `environment`. */
  baseUrl?: string;
  /**
   * Per-request timeout, milliseconds. Defaults to 30 000. The timer covers the whole `fetch` plus body read; on expiry
   * the request is aborted and an `InflowApiError` with `code: 'TIMEOUT'` is thrown.
   */
  timeoutMs?: number;
  /**
   * Optional `fetch` implementation. Defaults to `globalThis.fetch`. Useful for routing through a corporate proxy,
   * attaching OpenTelemetry instrumentation, or stubbing at the SDK boundary in tests. The injected function must
   * conform to the WHATWG fetch API.
   */
  fetch?: typeof fetch;
}

/**
 * Options accepted by {@link InflowHttpClient} when constructed without an API key. Only used by the seller-side
 * `createUnauthenticatedInflowFacilitator` factory; buyer-side flows and the seller client never construct anonymous
 * transports. Sends no `X-API-KEY` header on outbound requests.
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
   * Invoked once per HTTP attempt (a 5xx retry re-invokes it, picking up a freshly-refreshed token). Must return the
   * access token to send as `Authorization: Bearer <token>`. The callback's return value is not cached by the SDK;
   * callers that refresh proactively (60s expiry buffer is the recommended pattern) should do so inside this callback.
   *
   * Errors thrown by `getAccessToken` propagate to the caller of `get` / `post` / `request` verbatim — they are not
   * wrapped in `InflowApiError`, and they bypass the transient-error retry loop. Auth failures are not API errors; the
   * SDK is just a transport.
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
   * Maximum retry attempts on transient failures (HTTP 429, 502, 503, 504, and network errors). Capped at 3. Pass `0`
   * to disable retries — used by the buyer signer's polling loop, where the outer poller controls retry semantics.
   */
  retries?: number;
  /** Override the client-level `timeoutMs` for this call. */
  timeoutMs?: number;
  /** Additional headers merged on top of the SDK's standard headers. */
  headers?: Record<string, string>;
  /**
   * AbortSignal for caller-driven cancellation. Composes with the request-internal timeout signal; whichever fires
   * first aborts the request.
   */
  signal?: AbortSignal;
}

interface ParsedResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * HTTP client used by every other package in this monorepo to talk to `api.inflowpay.ai`. Carries auth-header injection
 * (`X-API-KEY` from {@link InflowClientOptions}, `Authorization: Bearer` from {@link InflowBearerClientOptions}'s
 * `getAccessToken` callback invoked once per attempt, or no auth header in anonymous mode), retry on transient statuses
 * (429, 502, 503, 504) with exponential backoff capped at three attempts, request timeout, JSON parsing, and error
 * mapping into {@link InflowApiError}.
 *
 * Construct one instance per `(auth, environment)` pair and share it across requests.
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
   *   {@link InflowBearerClientOptions}. The authed form requires `apiKey` to be a non-empty string; the anonymous form
   *   omits it entirely and sends no `X-API-KEY` header; the bearer form supplies an async `getAccessToken` callback
   *   invoked once per HTTP attempt. Anonymous mode is used only by `createUnauthenticatedInflowFacilitator` in
   *   `@inflowpayai/x402-seller`.
   * @throws {Error} When `apiKey` is present but empty, when `apiKey` and `getAccessToken` are both set, or when
   *   `getAccessToken` is set but not a function. (Server-side codes are mapped to {@link InflowApiError}; these are
   *   local precondition failures.)
   */
  constructor(options: InflowClientOptions);
  constructor(options: InflowAnonymousClientOptions);
  constructor(options: InflowBearerClientOptions);
  // TS overload resolution can't pick a specific arm from a union argument; this catch-all lets callers that already
  // hold a `InflowClientOptions | InflowAnonymousClientOptions | InflowBearerClientOptions`-typed value (notably
  // `createInflowSigner` in `@inflowpayai/x402-buyer`) construct without narrowing at the call site.
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

    // boundary cast — runtime narrows the discriminated union
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
   * @typeParam T - Expected shape of the parsed body. Not validated at runtime; callers are responsible for narrowing.
   * @param path - Path including leading slash, e.g. `'/v1/x402/config'`.
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
   * Lower-level entry point. Prefer {@link InflowHttpClient.get} / {@link InflowHttpClient.post} unless the verb is one
   * neither covers.
   *
   * @typeParam T - Expected shape of the parsed body.
   * @param method - HTTP verb.
   * @param path - Path including leading slash.
   * @param body - Optional value serialized via `JSON.stringify`.
   * @param options - Per-call overrides.
   * @returns Parsed JSON body cast to `T`.
   */
  async request<T>(method: string, path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const maxRetries = Math.min(options.retries ?? MAX_RETRIES, MAX_RETRIES);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    // Single-exit loop: the function either returns a parsed body on
    // 2xx or throws an InflowApiError. The retry budget is consumed
    // inline; when it's exhausted the catch / branch falls through to
    // the final throw, so there's no unreachable "fallback" throw
    // after the loop.
    for (let attempt = 0; ; attempt += 1) {
      // Build the per-attempt auth headers OUTSIDE the network try/catch:
      // a rejected `getAccessToken` propagates verbatim, never enters the
      // retry path, and is never wrapped in InflowApiError. Re-invoked per
      // attempt so a 5xx retry picks up a freshly-refreshed bearer token.
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

function parseJsonOrText(text: string, contentType: string | null): unknown {
  if (text.length === 0) return undefined;
  if (contentType !== null && contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  // Best-effort JSON parse for servers that omit content-type.
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function buildApiError(path: string, response: ParsedResponse): InflowApiError {
  const requestId = readHeader(response.headers, REQUEST_ID_HEADER);
  const code = extractCode(response.body);
  return InflowApiError.from({
    code,
    httpStatus: response.status,
    endpoint: path,
    ...(requestId !== undefined ? { requestId } : {}),
    body: response.body,
    headers: response.headers,
  });
}

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
 * Identity check for the internal timeout sentinel. Looks at the raw `cause` value, and at `err.cause` when the runtime
 * has wrapped the abort reason in a `DOMException` / `AbortError`. The latter shape is what Node 20+ surfaces from
 * `fetch` when the controller fires.
 */
function isTimeoutReason(value: unknown): boolean {
  if (value === TIMEOUT_REASON) return true;
  if (typeof value === 'object' && value !== null && 'cause' in value) {
    if (value.cause === TIMEOUT_REASON) return true;
  }
  return false;
}

function extractCode(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'code' in body) {
    const raw = body.code;
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return 'UNEXPECTED_ERROR';
}

function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Timeouts and connection-reset / unreachable errors are retryable;
  // abort triggered by the caller's own signal is not. Identity-compare
  // the abort `cause` against TIMEOUT_REASON instead of relying on the
  // error's `.message` (which the runtime can rewrite between versions).
  if (err.name === 'AbortError') {
    return isTimeoutReason(err);
  }
  return true;
}

function backoffMs(attempt: number): number {
  // 200 ms, 400 ms, 800 ms with a small jitter so concurrent callers don't
  // resynchronise.
  const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * (base / 4));
  return base + jitter;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
