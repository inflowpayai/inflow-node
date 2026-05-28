/**
 * Buyer-side probe utilities — minimal `fetch` wrappers and HTTP-header parsing helpers used to drive the x402
 * client/server handshake from any consumer that already has a buyer-signed payment in hand. Imported via the
 * `@inflowpayai/x402-buyer/probe` subpath so signing-only consumers don't pull this code.
 *
 * Composes cleanly with the {@link createInflowClient} factory exported from the package root: call `sellerProbe` to
 * issue the initial request, decode the 402 with the foundation helpers, sign via `inflow.createPaymentPayload`, then
 * `replayWithPayment` with the encoded payload to fetch the resource.
 */

/** Parsed `Name: Value` pair produced by {@link parseHeaderFlag}. */
export interface ParsedHeaderFlag {
  name: string;
  value: string;
}

/**
 * Thrown by {@link parseHeaderFlag} (and therefore {@link parseHeaderFlags}) when the input does not match the expected
 * `"Name: Value"` shape. The offending input is captured on the instance for diagnostics; sanitize before logging if
 * the input may itself carry secret material.
 */
export class X402HeaderFlagFormatError extends Error {
  readonly input: string;

  constructor(input: string) {
    super(`Invalid --header value ${JSON.stringify(input)}; expected "Name: Value".`);
    this.name = 'X402HeaderFlagFormatError';
    this.input = input;
  }
}

/**
 * Parse a CLI-style header flag (`"Name: Value"`) into its structured form. Splits on the first `:`; later colons (e.g.
 * inside a URL) are preserved in the value. Trims both halves. Throws {@link X402HeaderFlagFormatError} when the colon
 * is absent or either half is empty.
 */
export function parseHeaderFlag(input: string): ParsedHeaderFlag {
  const separator = input.indexOf(':');
  if (separator <= 0) {
    throw new X402HeaderFlagFormatError(input);
  }
  const name = input.slice(0, separator).trim();
  const value = input.slice(separator + 1).trim();
  if (name.length === 0 || value.length === 0) {
    throw new X402HeaderFlagFormatError(input);
  }
  return { name, value };
}

/**
 * Parse a list of CLI-style header flags into a `Record`. Duplicate names use the last value wins, matching the
 * behavior of most HTTP clients when populating headers from `--header` flags.
 */
export function parseHeaderFlags(inputs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of inputs) {
    const { name, value } = parseHeaderFlag(raw);
    out[name] = value;
  }
  return out;
}

/** Options for {@link sellerProbe}. */
export interface SellerProbeOptions {
  method: string;
  headers: Record<string, string>;
  /** Optional request body. Defaults `Content-Type` to `application/json` when set and no override is supplied. */
  data?: string;
}

/** Result of a {@link sellerProbe} or {@link replayWithPayment} call. */
export interface SellerProbeResult {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  contentType: string | undefined;
}

/**
 * Make a request against a seller endpoint and capture the response without trying to interpret the body. Returns the
 * raw bytes, the response headers, and the content-type for downstream decoding (e.g. extracting a PAYMENT-REQUIRED
 * header from a 402).
 *
 * When `options.data` is present and no `Content-Type` header was supplied, defaults to `application/json` — matches
 * the convention used by curl-style CLI flags.
 */
export async function sellerProbe(url: string, options: SellerProbeOptions): Promise<SellerProbeResult> {
  const headers = new Headers(options.headers);
  if (options.data !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const requestInit: RequestInit = {
    method: options.method,
    headers,
  };
  if (options.data !== undefined) {
    requestInit.body = options.data;
  }
  const response = await globalThis.fetch(url, requestInit);
  const buffer = await response.arrayBuffer();
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(buffer),
    contentType: response.headers.get('content-type') ?? undefined,
  };
}

/** Options for {@link replayWithPayment}. Extends {@link SellerProbeOptions} with the buyer-signed payment payload. */
export interface ReplayOptions extends SellerProbeOptions {
  /** The encoded payment payload returned by the buyer signer; sent as the `PAYMENT-SIGNATURE` header. */
  paymentSignature: string;
}

/**
 * Replay a request against the same seller endpoint, this time with a `PAYMENT-SIGNATURE` header carrying the
 * buyer-signed payload. Other headers from the original probe are preserved. Returns the same {@link SellerProbeResult}
 * shape so callers can apply the same body-decoding logic to both probes.
 */
export async function replayWithPayment(url: string, options: ReplayOptions): Promise<SellerProbeResult> {
  return sellerProbe(url, {
    method: options.method,
    headers: { ...options.headers, 'PAYMENT-SIGNATURE': options.paymentSignature },
    ...(options.data !== undefined ? { data: options.data } : {}),
  });
}

/**
 * Best-effort decode of a response body into both a UTF-8 string and a base64 mirror, alongside the byte count. The
 * UTF-8 decode runs in `fatal: true` mode and returns `text: undefined` when the bytes are not valid UTF-8; the base64
 * representation is always available. Callers display the text form when available and fall back to base64 for binary
 * payloads.
 */
export function describeBody(bytes: Uint8Array): {
  text: string | undefined;
  base64: string;
  size: number;
} {
  const size = bytes.byteLength;
  const base64 = Buffer.from(bytes).toString('base64');
  const text = tryDecodeUtf8(bytes);
  if (text === undefined) {
    return { text: undefined, base64, size };
  }
  return { text, base64, size };
}

function tryDecodeUtf8(bytes: Uint8Array): string | undefined {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}
