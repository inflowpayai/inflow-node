import type { MppProblemDetail } from './types.js';

/**
 * Header names whose values must be stripped before storing on {@link InflowApiError.headers}. Comparison is
 * case-insensitive.
 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);

/**
 * Strip sensitive header values from a raw header bag and return a frozen record of the remaining headers, keyed by
 * their original lowercased name.
 *
 * @param raw - The header bag to sanitize, or `undefined`.
 * @returns A frozen record of non-sensitive headers, or `undefined` when `raw` was `undefined`.
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
   * Application-level error code extracted from the response body's `code` field, falling back to `'UNEXPECTED_ERROR'`.
   * `'TIMEOUT'` and `'NETWORK_ERROR'` are synthesised by the client for transport failures.
   */
  code: string;
  /** HTTP status of the failing response. `0` for transport-level failures (timeout / network error). */
  httpStatus: number;
  /** Endpoint path (relative to the base URL) that produced the failure. */
  endpoint: string;
  /** Server-issued correlation ID, read from `X-Request-Id` on the response. `undefined` when the server emitted none. */
  requestId?: string;
  /** Underlying error (e.g. a `fetch` rejection) when this wraps another. */
  cause?: unknown;
  /** Parsed JSON body when the response was JSON; raw text otherwise. */
  body?: unknown;
  /**
   * RFC 9457 problem detail parsed off the response body when it carried one. MPP failures on `/v1/mpp/redeem` and the
   * buyer endpoints surface in the response body rather than as a problem-typed HTTP error, so this is populated only
   * when a non-2xx response itself carried a problem shape.
   */
  problem?: MppProblemDetail;
  /** Response headers with sensitive entries (`authorization`, `cookie`, `set-cookie`, `x-api-key`) stripped. */
  headers?: Headers | Record<string, string | readonly string[] | undefined>;
}

/**
 * Error thrown by every {@link MppClient} call on a non-2xx response or terminal transport failure. Carries the
 * server-issued correlation ID when available and the (sanitized) response body and headers for diagnostics.
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
  /** {@inheritDoc InflowApiErrorInit.problem} */
  readonly problem?: MppProblemDetail;
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
    if (init.problem !== undefined) this.problem = init.problem;
    const headers = sanitizeHeaders(init.headers);
    if (headers !== undefined) this.headers = headers;
  }

  /**
   * Compose an {@link InflowApiError} from a non-2xx response.
   *
   * `.message` is the server's human-readable message — the RFC 9457 problem `detail`, then a body `message`, then a
   * generic `request failed` fallback. Transport/diagnostic details — `endpoint`, `httpStatus`, `requestId`, `code`,
   * `problem`, and the raw `body` — are carried as fields on the instance, not folded into the message, so consumers
   * (CLIs, logs) can present a clean message and opt into the diagnostics they need.
   *
   * @param init - Structured fields carried on the resulting instance.
   * @returns A new {@link InflowApiError}.
   */
  static from(init: InflowApiErrorInit): InflowApiError {
    const message = init.problem?.detail ?? extractBodyMessage(init.body) ?? 'request failed';
    return new InflowApiError(message, init);
  }
}

/**
 * Extract a human-readable message from a response body, if present.
 *
 * @param body - The parsed response body.
 * @returns The body's `message` string when non-empty, otherwise `undefined`.
 */
function extractBodyMessage(body: unknown): string | undefined {
  if (body !== null && typeof body === 'object' && 'message' in body) {
    const raw = body.message;
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return undefined;
}

/**
 * Thrown when encoding to, or decoding from, the MPP wire fails: a malformed base64url string, JSON that is not the
 * expected shape, or a `WWW-Authenticate` value that is not a `Payment` challenge. A codec failure on the
 * canonicalisation path would otherwise break the foundation SDK's HMAC binding silently, so it is raised loudly at the
 * boundary.
 */
export class MppCodecError extends Error {
  /** Short label for the artefact being processed when the failure occurred (e.g. `'credential'`, `'challenge header'`). */
  readonly artifact: string;

  /**
   * @param artifact - The artefact being encoded or decoded (used in the message).
   * @param detail - What specifically went wrong.
   * @param cause - The underlying error, when wrapping one.
   */
  constructor(artifact: string, detail: string, cause?: unknown) {
    super(`MPP codec: failed to process ${artifact} — ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'MppCodecError';
    this.artifact = artifact;
  }
}

/**
 * Thrown when the PSP's advertised protocol/SDK floor is incompatible with this SDK: either the server's
 * `protocolVersion` differs from the supported `MPP_PROTOCOL_VERSION`, or the server's `minSdkVersion` exceeds this
 * SDK's version. The SDK does not negotiate — an incompatibility is a hard error surfaced at config time, analogous to
 * `@inflowpayai/x402`'s `X402VersionMismatchError`.
 */
export class MppProtocolVersionError extends Error {
  /** The kind of version that was incompatible. */
  readonly kind: 'protocol' | 'sdk';
  /** The version this SDK supports (protocol version) or runs at (SDK version). */
  readonly expected: string;
  /** The version the server advertised (`protocolVersion` or `minSdkVersion`). */
  readonly received: string;

  /**
   * @param kind - `'protocol'` when `protocolVersion` mismatched, `'sdk'` when this SDK is below `minSdkVersion`.
   * @param expected - The supported protocol version, or this SDK's version.
   * @param received - The server-advertised value.
   */
  constructor(kind: 'protocol' | 'sdk', expected: string, received: string) {
    const message =
      kind === 'protocol'
        ? `Unsupported MPP protocol version: expected ${expected}, server advertised ${received}`
        : `SDK version ${expected} is below the PSP's minimum supported version ${received}`;
    super(message);
    this.name = 'MppProtocolVersionError';
    this.kind = kind;
    this.expected = expected;
    this.received = received;
  }
}
