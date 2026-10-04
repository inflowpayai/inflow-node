import { createHash, verify } from 'node:crypto';
import { TapVerificationError } from './errors.js';
import { VisaTapKeyResolver } from './key-resolver.js';
import { MemoryTapReplayStore } from './replay-store.js';
import type { TapRequest, TapVerificationFacts, TapVerifier, TapVerifierOptions } from './types.js';

const REQUIRED_COMPONENTS = ['@method', '@authority', '@path', '@query'] as const;
const BODY_COMPONENTS = ['content-digest', 'content-type'] as const;
const INPUT_PATTERN = /^ *sig2=\( *(?<components>"[a-z@-]+"(?: +"[a-z@-]+")*) *\)(?<parameters>[^\r\n]*)$/;
const PARAMETER_PATTERN =
  /^; *(created|expires|keyid|alg|nonce|tag)(?:=("(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"|-?\d{1,12}\.\d{1,3}|-?\d{1,15}|\?[01]|:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?:|[A-Za-z*][A-Za-z0-9!#$%&'*+.^_`|~:/-]*))?(?=;|[ \t]*$)/;
const SIGNATURE_PATTERN =
  /^ *sig2=:(?<value>(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?):[ \t]*$/;

interface ParsedInput {
  readonly components: readonly string[];
  readonly created: number;
  readonly expires: number;
  readonly keyid: string;
  readonly algorithm: string;
  readonly nonce: string;
  readonly tag: 'agent-browser-auth' | 'agent-payer-auth';
  readonly parameters: string;
}

const SUPPORTED_ALGORITHMS = new Set(['ed25519', 'Ed25519']);

export function createTapVerifier(options: TapVerifierOptions = {}): TapVerifier {
  const keyResolver = options.keyResolver ?? new VisaTapKeyResolver();
  const clock = options.clock ?? Date.now;
  const replayStore = options.replayStore ?? new MemoryTapReplayStore(clock);

  return {
    async verify(request: TapRequest): Promise<TapVerificationFacts> {
      const signatureInput = requiredHeader(request.headers, 'signature-input');
      const signature = requiredHeader(request.headers, 'signature');
      const parsed = parseInput(signatureInput);
      validateComponents(parsed.components, request.body !== undefined);
      const now = Math.floor(clock() / 1000);
      validateTime(parsed, now);
      const url = new URL(request.url);
      const values = componentValues(request, url);
      validateDigest(request, values);
      const key = await keyResolver.resolve(parsed.keyid, parsed.algorithm);
      if (key === undefined) throw failure('KEY_NOT_FOUND', 'The TAP verification key was not found.');
      const signatureBase = [
        ...parsed.components.map((component) => `"${component}": ${values.get(component) ?? ''}`),
        `"@signature-params": ${parsed.parameters}`,
      ].join('\n');
      if (
        key.key.asymmetricKeyType !== 'ed25519' ||
        !verify(null, Buffer.from(signatureBase), key.key, parseSignature(signature))
      ) {
        throw failure('SIGNATURE_INVALID', 'The TAP signature is invalid.');
      }
      if (!(await replayStore.claim(parsed.keyid, parsed.nonce, parsed.expires))) {
        throw failure('NONCE_REPLAYED', 'The TAP nonce has already been used.');
      }
      return {
        verified: true,
        keyid: parsed.keyid,
        algorithm: 'ed25519',
        intent: parsed.tag === 'agent-payer-auth' ? 'pay' : 'browse',
        nonce: parsed.nonce,
        created: parsed.created,
        expires: parsed.expires,
        coveredComponents: parsed.components,
      };
    },
  };
}

function parseInput(value: string): ParsedInput {
  const groups = INPUT_PATTERN.exec(value)?.groups;
  const componentsValue = groups?.['components'];
  const parameterValue = groups?.['parameters'];
  if (componentsValue === undefined || parameterValue === undefined) {
    throw failure('SIGNATURE_INPUT_INVALID', 'The TAP Signature-Input field is invalid.');
  }
  const components = componentsValue.split(/ +/).map((component) => component.slice(1, -1));
  if (new Set(components).size !== components.length) {
    throw failure('SIGNATURE_INPUT_INVALID', 'The TAP covered components are invalid.');
  }
  const parameters = new Map<string, string | number | undefined>();
  let remaining = parameterValue.replace(/[ \t]+$/, '');
  while (remaining !== '') {
    const parameter = PARAMETER_PATTERN.exec(remaining);
    const name = parameter?.[1];
    if (parameter === null || name === undefined) {
      throw failure('SIGNATURE_INPUT_INVALID', 'The TAP Signature-Input field is invalid.');
    }
    const encoded = parameter[2];
    const decoded =
      encoded?.startsWith('"') === true
        ? encoded.slice(1, -1).replace(/\\(["\\])/g, '$1')
        : encoded !== undefined && /^-?\d+$/.test(encoded)
          ? Number(encoded)
          : undefined;
    // RFC 8941 parameters keep their first position and their last value, including its type.
    parameters.set(name, decoded);
    remaining = remaining.slice(parameter[0].length);
  }
  const created = parameters.get('created');
  const expires = parameters.get('expires');
  const keyid = parameters.get('keyid');
  const algorithm = parameters.get('alg');
  const nonce = parameters.get('nonce');
  const tag = parameters.get('tag');
  if (
    typeof created !== 'number' ||
    typeof expires !== 'number' ||
    typeof keyid !== 'string' ||
    keyid === '' ||
    typeof algorithm !== 'string' ||
    !SUPPORTED_ALGORITHMS.has(algorithm) ||
    typeof nonce !== 'string' ||
    nonce === '' ||
    (tag !== 'agent-browser-auth' && tag !== 'agent-payer-auth')
  ) {
    throw failure('SIGNATURE_INPUT_INVALID', 'The TAP signature parameters are invalid.');
  }
  const serialized = [...parameters]
    .map(([name, item]) => `;${name}=${typeof item === 'string' ? `"${item.replace(/["\\]/g, '\\$&')}"` : item}`)
    .join('');
  return {
    components,
    created,
    expires,
    keyid,
    algorithm: 'ed25519',
    nonce,
    tag,
    parameters: `(${components.map((component) => `"${component}"`).join(' ')})${serialized}`,
  };
}

function validateComponents(components: readonly string[], hasBody: boolean): void {
  const required = hasBody ? [...REQUIRED_COMPONENTS, ...BODY_COMPONENTS] : REQUIRED_COMPONENTS;
  if (components.length !== required.length || required.some((component) => !components.includes(component))) {
    throw failure('SIGNATURE_INPUT_INVALID', 'The TAP covered components are invalid.');
  }
}

function validateTime(input: ParsedInput, now: number): void {
  if (input.expires <= input.created || input.expires - input.created > 480) {
    throw failure('SIGNATURE_LIFETIME_INVALID', 'The TAP signature lifetime is invalid.');
  }
  if (now < input.created) throw failure('SIGNATURE_NOT_YET_VALID', 'The TAP signature is not yet valid.');
  if (now >= input.expires) throw failure('SIGNATURE_EXPIRED', 'The TAP signature has expired.');
}

function componentValues(request: TapRequest, url: URL): Map<string, string> {
  const values = new Map<string, string>([
    ['@method', request.method],
    ['@authority', url.host],
    ['@path', url.pathname],
    ['@query', url.search === '' ? '?' : url.search],
  ]);
  const digest = optionalHeader(request.headers, 'content-digest');
  const contentType =
    request.body === undefined
      ? optionalHeader(request.headers, 'content-type')
      : requiredHeader(request.headers, 'content-type');
  if (digest !== undefined) values.set('content-digest', digest);
  if (contentType !== undefined) values.set('content-type', contentType);
  return values;
}

function validateDigest(request: TapRequest, values: ReadonlyMap<string, string>): void {
  if (request.body === undefined) return;
  const body = typeof request.body === 'string' ? Buffer.from(request.body) : Buffer.from(request.body);
  const expected = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
  if (values.get('content-digest') !== expected) {
    throw failure('CONTENT_DIGEST_INVALID', 'The TAP content digest is invalid.');
  }
}

function parseSignature(value: string): Buffer {
  const groups = SIGNATURE_PATTERN.exec(value)?.groups;
  const encoded = groups?.['value'];
  if (encoded === undefined) throw failure('SIGNATURE_INPUT_INVALID', 'The TAP Signature field is invalid.');
  return Buffer.from(encoded, 'base64');
}

function requiredHeader(headers: TapRequest['headers'], name: string): string {
  const value = optionalHeader(headers, name);
  if (value === undefined) throw failure('SIGNATURE_INPUT_INVALID', `The TAP ${name} field is missing.`);
  return value;
}

function optionalHeader(headers: TapRequest['headers'], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (entries.length !== 1) return undefined;
  const entry = entries[0]?.[1];
  if (typeof entry === 'string') return entry;
  return entry?.length === 1 ? entry[0] : undefined;
}

function failure(code: ConstructorParameters<typeof TapVerificationError>[0], message: string): TapVerificationError {
  return new TapVerificationError(code, message);
}
