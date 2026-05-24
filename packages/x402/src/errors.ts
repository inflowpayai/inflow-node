import { X402_VERSION } from './constants.js';

/**
 * Header names whose values must be stripped before storing on {@link InflowApiError.headers}. Comparison is
 * case-insensitive.
 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);

/**
 * Strip sensitive header values from a raw header bag and return a frozen record of the remaining headers, keyed by
 * their original lowercased name.
 */
function sanitizeHeaders(
  raw: Headers | Record<string, string | readonly string[] | undefined> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  const out: Record<string, string> = {};
  const append = (name: string, value: string | readonly string[] | undefined): void => {
    if (value === undefined) return;
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) return;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : (value as string);
  };
  if (typeof Headers !== 'undefined' && raw instanceof Headers) {
    raw.forEach((value, name) => append(name, value));
  } else {
    const record = raw as Record<string, string | readonly string[] | undefined>;
    for (const name of Object.keys(record)) {
      append(name, record[name]);
    }
  }
  return Object.freeze(out);
}

/**
 * Constructor parameters for {@link InflowApiError}. Every field except `message` corresponds to an attribute carried on
 * the resulting error instance.
 */
export interface InflowApiErrorInit {
  /**
   * Application-level error code extracted from the response body's `code` field. Falls back to `'UNEXPECTED_ERROR'`
   * when the body did not carry a code. Specific values consumers may branch on include `INSUFFICIENT_FUNDS`,
   * `PARAMETER_REQUIRED`, `PARAMETER_INVALID`, `BLOCKCHAIN_NOT_FOUND`, and `USER_NOT_FOUND`.
   */
  code: string;
  /** HTTP status of the failing response. */
  httpStatus: number;
  /** Endpoint path (relative to the base URL) that produced the failure. */
  endpoint: string;
  /**
   * Server-issued correlation ID, read from `X-Request-Id` on the response. `undefined` when the server did not emit
   * one.
   */
  requestId?: string;
  /** Underlying error (e.g. a `fetch` rejection) when this wraps another. */
  cause?: unknown;
  /** Parsed JSON body when the response was JSON; raw text otherwise. */
  body?: unknown;
  /** Response headers with sensitive entries (`authorization`, `cookie`, `set-cookie`, `x-api-key`) stripped. */
  headers?: Headers | Record<string, string | readonly string[] | undefined>;
}

/**
 * Error thrown by every {@link InflowHttpClient} call on a non-2xx response. Carries the server-issued correlation ID
 * when available and the (sanitized) response body and headers for diagnostics.
 */
export class InflowApiError extends Error {
  /** {@inheritDoc InflowApiErrorInit.code} */
  readonly code: string;
  /** {@inheritDoc InflowApiErrorInit.httpStatus} */
  readonly httpStatus: number;
  /** {@inheritDoc InflowApiErrorInit.endpoint} */
  readonly endpoint: string;
  /** {@inheritDoc InflowApiErrorInit.requestId} */
  readonly requestId?: string;
  /** {@inheritDoc InflowApiErrorInit.body} */
  readonly body?: unknown;
  /** {@inheritDoc InflowApiErrorInit.headers} */
  readonly headers?: Readonly<Record<string, string>>;

  /**
   * @param message - Human-readable message. Callers should prefer the factory {@link InflowApiError.from} which
   *   composes a standard message shape including endpoint, status, code, and request ID.
   * @param init - Structured fields carried on the resulting instance.
   */
  constructor(message: string, init: InflowApiErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'InflowApiError';
    this.code = init.code;
    this.httpStatus = init.httpStatus;
    this.endpoint = init.endpoint;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.body !== undefined) this.body = init.body;
    const headers = sanitizeHeaders(init.headers);
    if (headers !== undefined) this.headers = headers;
  }

  /**
   * Compose an {@link InflowApiError} with a standard message shape.
   *
   * Format: `[<requestId>] <endpoint>: <httpStatus> <code> — <bodyMessage>`, where `<requestId>` is omitted when
   * missing and `<bodyMessage>` falls back to a generic `request failed` when the body had no `message` field.
   */
  static from(init: InflowApiErrorInit): InflowApiError {
    const prefix = init.requestId !== undefined ? `[${init.requestId}] ` : '';
    const bodyMessage = extractBodyMessage(init.body) ?? 'request failed';
    const message = `${prefix}${init.endpoint}: ${init.httpStatus} ${init.code} — ${bodyMessage}`;
    return new InflowApiError(message, init);
  }
}

function extractBodyMessage(body: unknown): string | undefined {
  if (body !== null && typeof body === 'object' && 'message' in body) {
    const raw = body.message;
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return undefined;
}

/**
 * Thrown when a response advertises an `x402Version` other than the SDK's supported version ({@link X402_VERSION} = 2).
 * The SDK does not attempt version negotiation: only V2 is supported and any other value is a hard error so consumers
 * see the mismatch at the boundary instead of as a silent decode failure deeper in.
 */
export class X402VersionMismatchError extends Error {
  /** Version reported by the server (or `unknown` when the field was absent). */
  readonly receivedVersion: number | 'unknown';
  /** Endpoint or context that produced the mismatched payload. */
  readonly endpoint: string;

  /**
   * @param receivedVersion - The `x402Version` value the response carried, or the string `'unknown'` when the field was
   *   missing or not a number.
   * @param endpoint - The endpoint path or context the SDK was processing when it saw the version field, used in the
   *   generated message.
   */
  constructor(receivedVersion: number | 'unknown', endpoint: string) {
    super(`Expected x402Version ${X402_VERSION}; got ${receivedVersion} on ${endpoint}`);
    this.name = 'X402VersionMismatchError';
    this.receivedVersion = receivedVersion;
    this.endpoint = endpoint;
  }
}
