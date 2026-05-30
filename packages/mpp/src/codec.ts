import { SCHEME_PAYMENT } from './constants.js';
import { MppCodecError } from './errors.js';
import type { MppChallenge, MppCredential, MppReceipt } from './types.js';

// ---------------------------------------------------------------------------
// RFC 8785 JCS canonicalisation
//
// A faithful TypeScript port of the server's `ai.inflowpay.utility.Jcs` plus the `Include.NON_NULL` behaviour of its
// `CustomJSONMapper`. Object keys are sorted by UTF-16 code unit (JS default string order — identical to Java
// `String.compareTo`); object properties whose value is `null`/`undefined` are dropped before sorting (NON_NULL); JSON
// numbers use the ECMAScript `Number::toString` algorithm, which is exactly what RFC 8785 mandates and what the Java
// `JcsNumberFormatter` reimplements. The result is the canonical UTF-8 byte string the foundation SDK (mppx) HMAC-binds
// against (and the server renders identically), so a divergence here would silently break the challenge binding. Hence
// this is hand-rolled and byte-tested rather than delegated.
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';

/**
 * Append a JCS-escaped JSON string (including surrounding quotes) to `out`. Escapes `"`, `\`, and the C0 control set
 * per RFC 8785 (`\b \f \n \r \t`, else `\u00xx` lowercase); all other code points — including non-ASCII — are emitted
 * verbatim as UTF-8.
 *
 * @param value - The raw string to escape.
 * @param out - Accumulator the escaped, quoted form is appended to.
 */
function appendQuoted(value: string, out: string[]): void {
  out.push('"');
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const ch = value[i] as string;
    switch (ch) {
      case '"':
        out.push('\\"');
        break;
      case '\\':
        out.push('\\\\');
        break;
      case '\b':
        out.push('\\b');
        break;
      case '\f':
        out.push('\\f');
        break;
      case '\n':
        out.push('\\n');
        break;
      case '\r':
        out.push('\\r');
        break;
      case '\t':
        out.push('\\t');
        break;
      default:
        if (code < 0x20) {
          out.push('\\u00', HEX[(code >>> 4) & 0xf] as string, HEX[code & 0xf] as string);
        } else {
          out.push(ch);
        }
        break;
    }
  }
  out.push('"');
}

/**
 * Format a finite JS number as an RFC 8785 JSON number. RFC 8785 defines number serialisation as the ECMAScript
 * `Number::toString`, so `String(value)` is canonical (including `-0` → `"0"`); only non-finite values are rejected.
 *
 * @param value - The number to format.
 * @returns The canonical JSON number string.
 * @throws {@link MppCodecError} When `value` is `NaN` or infinite (not representable in JSON).
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new MppCodecError('number', `${value} is not a finite JSON number`);
  }
  return Object.is(value, -0) ? '0' : String(value);
}

/**
 * Append the canonical JCS form of any JSON-compatible value to `out`.
 *
 * @param value - The value to canonicalise.
 * @param out - Accumulator the canonical text is appended to.
 */
function write(value: unknown, out: string[]): void {
  if (value === null || value === undefined) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'string':
      appendQuoted(value, out);
      return;
    case 'number':
      out.push(formatNumber(value));
      return;
    case 'bigint':
      out.push(value.toString());
      return;
    case 'object':
      break;
    default:
      throw new MppCodecError('value', `unsupported JSON value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(',');
      write(value[i], out);
    }
    out.push(']');
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== null && record[key] !== undefined);
  keys.sort();
  out.push('{');
  let first = true;
  for (const key of keys) {
    if (!first) out.push(',');
    appendQuoted(key, out);
    out.push(':');
    write(record[key], out);
    first = false;
  }
  out.push('}');
}

/**
 * Canonicalise a value to its RFC 8785 JCS JSON string. Object keys are sorted, `null`/`undefined` object properties
 * are dropped, and strings/numbers are escaped/formatted per the spec.
 *
 * @param value - The value to canonicalise.
 * @returns The canonical JSON text.
 */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join('');
}

// ---------------------------------------------------------------------------
// base64url (no padding) over the canonical JSON bytes
// ---------------------------------------------------------------------------

/**
 * Re-pad a base64url string to a length that is a multiple of 4, matching the server's `MppCodec.getPaddingIfNeeded`.
 *
 * @param input - The (unpadded) base64url string.
 * @returns `input` with `=` padding restored.
 * @throws {@link MppCodecError} When `input.length % 4 === 1`, which can never result from valid base64.
 */
export function padBase64Url(input: string): string {
  const remainder = input.length % 4;
  switch (remainder) {
    case 0:
      return input;
    case 2:
      return `${input}==`;
    case 3:
      return `${input}=`;
    default:
      throw new MppCodecError('base64url', `invalid length (mod 4 == ${remainder}); cannot be re-padded`);
  }
}

/**
 * Encode a value as base64url-without-padding over its canonical (RFC 8785 JCS) JSON. This is the wire form for
 * `request`, `credential`, and `receipt`.
 *
 * @param value - The value to encode.
 * @returns The base64url-without-padding string.
 */
export function encode(value: unknown): string {
  return Buffer.from(canonicalize(value), 'utf8').toString('base64url');
}

/**
 * Decode a base64url string into a JSON value. Mirrors the server's `MppCodec` decode path: re-pad, base64url-decode,
 * then `JSON.parse` (decoding does not canonicalise).
 *
 * @typeParam T - Expected shape of the decoded value. Not validated at runtime beyond JSON well-formedness.
 * @param value - The base64url string (padding optional).
 * @param artifact - Short label used in error messages (e.g. `'credential'`).
 * @returns The parsed value cast to `T`.
 * @throws {@link MppCodecError} When the input is not valid base64url or not valid JSON.
 */
export function decode<T>(value: string, artifact = 'value'): T {
  let json: string;
  try {
    json = Buffer.from(padBase64Url(value), 'base64url').toString('utf8');
  } catch (cause) {
    if (cause instanceof MppCodecError) throw cause;
    throw new MppCodecError(artifact, 'not valid base64url', cause);
  }
  try {
    return JSON.parse(json) as T;
  } catch (cause) {
    throw new MppCodecError(artifact, 'not valid JSON', cause);
  }
}

/**
 * Decode a base64url-encoded {@link MppCredential} (e.g. the `credential` field of a buyer transaction response, or an
 * `Authorization: Payment` value with the scheme prefix already stripped).
 *
 * @param value - The base64url credential string.
 * @returns The decoded credential.
 */
export function decodeCredential(value: string): MppCredential {
  return decode<MppCredential>(value, 'credential');
}

/**
 * Decode a base64url-encoded {@link MppReceipt} (e.g. a `Payment-Receipt` header value or `receiptHeader`).
 *
 * @param value - The base64url receipt string.
 * @returns The decoded receipt.
 */
export function decodeReceipt(value: string): MppReceipt {
  return decode<MppReceipt>(value, 'receipt');
}

/**
 * Encode an {@link MppCredential} to its base64url wire form for the `Authorization: Payment` header value.
 *
 * @param credential - The credential to encode.
 * @returns The base64url-without-padding credential string.
 */
export function encodeCredential(credential: MppCredential): string {
  return encode(credential);
}

// ---------------------------------------------------------------------------
// WWW-Authenticate: Payment header render / parse
// ---------------------------------------------------------------------------

const SCHEME_PREFIX = `${SCHEME_PAYMENT} `;
// Matches one auth-param: a quoted-string value (with backslash escapes) or a bare token value.
const PARAM_PATTERN = /(\w+)="((?:\\.|[^\\"])*)"|(\w+)=([^,\s]+)/g;
// Recognises the start of a new `Payment` challenge in the run following a separating comma (RFC 7235,
// case-insensitive). Used by {@link splitChallenges} to decide whether a comma is a challenge boundary.
const NEXT_CHALLENGE = /^Payment\s/i;

/**
 * RFC 7235 quoted-string escape for the `description` parameter: backslash-escape `\` and `"`. Control characters and
 * raw CR/LF are rejected — they would corrupt the header or open a header-injection vector. Matches the server's
 * `escapeQuotedString`.
 *
 * @param value - The raw description text.
 * @returns The escaped text, safe to place inside a quoted-string.
 * @throws {@link MppCodecError} When the value contains a disallowed control character.
 */
function escapeQuotedString(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const ch = value[i] as string;
    if (ch === '\r' || ch === '\n' || (code < 0x20 && ch !== '\t')) {
      throw new MppCodecError(
        'challenge header',
        `description contains a disallowed control character (0x${code.toString(16)})`,
      );
    }
    if (ch === '\\' || ch === '"') out += '\\';
    out += ch;
  }
  return out;
}

/**
 * RFC 7235 quoted-string un-escape: drop each backslash and keep the following character verbatim. Inverse of
 * {@link escapeQuotedString}; matches the server's `unescapeQuotedString`.
 *
 * @param value - The escaped quoted-string contents.
 * @returns The decoded text.
 */
function unescapeQuotedString(value: string): string {
  if (!value.includes('\\')) return value;
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string;
    if (ch === '\\' && i + 1 < value.length) {
      i += 1;
      out += value[i] as string;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Append one auth-param to a render accumulator, with `, ` separators between params.
 *
 * @param parts - Accumulated `key="value"` fragments.
 * @param key - Param name.
 * @param value - Param value, or `undefined` to skip.
 * @param escape - When true, RFC 7235 quoted-string escape the value (only for server-controlled-display fields).
 */
function appendParam(parts: string[], key: string, value: string | undefined, escape: boolean): void {
  if (value === undefined) return;
  parts.push(`${key}="${escape ? escapeQuotedString(value) : value}"`);
}

/**
 * Render an {@link MppChallenge} as a `WWW-Authenticate: Payment` header value. Field order and escaping mirror the
 * server's `MppChallenge.toWwwAuthenticateValue()` so a rendered header round-trips byte-for-byte.
 *
 * @param challenge - The challenge to render.
 * @returns The header value, e.g. `Payment id="…", realm="…", method="inflow", intent="charge", request="…"`.
 */
export function renderChallengeHeader(challenge: MppChallenge): string {
  const parts: string[] = [];
  appendParam(parts, 'id', challenge.id, false);
  appendParam(parts, 'realm', challenge.realm, false);
  appendParam(parts, 'method', challenge.method, false);
  appendParam(parts, 'intent', challenge.intent, false);
  appendParam(parts, 'request', challenge.request, false);
  appendParam(parts, 'expires', challenge.expires, false);
  appendParam(parts, 'description', challenge.description, true);
  appendParam(parts, 'digest', challenge.digest, false);
  return SCHEME_PREFIX + parts.join(', ');
}

/**
 * Parse a single `WWW-Authenticate: Payment` header value into an {@link MppChallenge}. The `Payment` scheme prefix is
 * matched case-insensitively (RFC 7235); `description` is quoted-string un-escaped; unknown params are ignored. Mirrors
 * the server's `MppChallenge.fromWwwAuthenticateValue()`, with the addition that the five required auth-params must be
 * present.
 *
 * @param headerValue - The header value (without the `WWW-Authenticate:` name).
 * @returns The parsed challenge.
 * @throws {@link MppCodecError} When the value is not a `Payment` challenge or is missing a required parameter.
 */
export function parseChallengeHeader(headerValue: string): MppChallenge {
  const trimmed = (headerValue ?? '').trim();
  if (
    trimmed.length < SCHEME_PREFIX.length ||
    trimmed.slice(0, SCHEME_PREFIX.length).toLowerCase() !== SCHEME_PREFIX.toLowerCase()
  ) {
    throw new MppCodecError('challenge header', "value is not a 'Payment' challenge");
  }
  const input = trimmed.slice(SCHEME_PREFIX.length).trim();

  const fields: Partial<Record<keyof MppChallenge, string>> = {};
  PARAM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PARAM_PATTERN.exec(input)) !== null) {
    const key = match[1] ?? match[3];
    const value = match[1] !== undefined ? match[2] : match[4];
    if (key === undefined || value === undefined) continue;
    switch (key) {
      case 'description':
        fields.description = unescapeQuotedString(value);
        break;
      case 'digest':
        fields.digest = value;
        break;
      case 'expires':
        fields.expires = value;
        break;
      case 'id':
        fields.id = value;
        break;
      case 'intent':
        fields.intent = value;
        break;
      case 'method':
        fields.method = value;
        break;
      case 'realm':
        fields.realm = value;
        break;
      case 'request':
        fields.request = value;
        break;
      default:
        break;
    }
  }

  for (const required of ['id', 'realm', 'method', 'intent', 'request'] as const) {
    if (fields[required] === undefined) {
      throw new MppCodecError('challenge header', `missing required parameter '${required}'`);
    }
  }

  const challenge: MppChallenge = {
    id: fields.id as string,
    realm: fields.realm as string,
    method: fields.method as string,
    intent: fields.intent as string,
    request: fields.request as string,
  };
  if (fields.expires !== undefined) challenge.expires = fields.expires;
  if (fields.description !== undefined) challenge.description = fields.description;
  if (fields.digest !== undefined) challenge.digest = fields.digest;
  return challenge;
}

/**
 * Parse one or more `WWW-Authenticate: Payment` challenges off a 402 response. Accepts the array of raw header values
 * (Node's repeated-header form) or a single value; a single value that carries several `, Payment …` challenges is
 * split. Mirrors the server's `MppChallenge.fromMultipleHeaders()`.
 *
 * @param headerValues - One header value, or the list of repeated `WWW-Authenticate` values.
 * @returns The parsed challenges, in encounter order.
 */
export function parseChallengeHeaders(headerValues: string | readonly string[]): MppChallenge[] {
  const values = typeof headerValues === 'string' ? [headerValues] : headerValues;
  const challenges: MppChallenge[] = [];
  for (const value of values) {
    for (const part of splitChallenges(value)) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      challenges.push(parseChallengeHeader(trimmed));
    }
  }
  return challenges;
}

/**
 * Split a single header value into its individual `Payment` challenges. Quote-aware: a comma only starts a new
 * challenge when it is **outside** a quoted-string and the following run begins a fresh `Payment ` token. A comma
 * inside a `description="…"` (which is never escaped away) stays part of its challenge rather than splitting it in
 * two.
 *
 * @param headerValue - One `WWW-Authenticate` header value, possibly carrying several `, Payment …` challenges.
 * @returns The challenge substrings in encounter order (leading whitespace is trimmed by the caller).
 */
function splitChallenges(headerValue: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < headerValue.length; i += 1) {
    const ch = headerValue[i];
    if (inQuotes) {
      // Skip the character after a backslash so an escaped `\"` does not close the quoted-string.
      if (ch === '\\') i += 1;
      else if (ch === '"') inQuotes = false;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',' && NEXT_CHALLENGE.test(headerValue.slice(i + 1).replace(/^\s+/, ''))) {
      parts.push(headerValue.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(headerValue.slice(start));
  return parts;
}
