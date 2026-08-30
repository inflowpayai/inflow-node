import { createHash, verify } from 'node:crypto';
import { TapVerificationError } from './errors.js';
import { VisaTapKeyResolver } from './key-resolver.js';
import { MemoryTapReplayStore } from './replay-store.js';
import type { TapRequest, TapVerificationFacts, TapVerifier, TapVerifierOptions } from './types.js';

const REQUIRED_COMPONENTS = ['@method', '@authority', '@path', '@query'] as const;
const BODY_COMPONENTS = ['content-digest', 'content-type'] as const;
const INPUT_PATTERN =
  /^sig2=\((?<components>(?:"[a-z@-]+" ?)+)\);created=(?<created>\d+);expires=(?<expires>\d+);keyid="(?<keyid>[A-Za-z0-9._~-]{1,128})";alg="(?<algorithm>[A-Za-z0-9-]+)";nonce="(?<nonce>[A-Za-z0-9+/_=-]+)";tag="(?<tag>agent-browser-auth|agent-payer-auth)"$/;
const SIGNATURE_PATTERN = /^sig2=:(?<value>[A-Za-z0-9+/]+={0,2}):$/;

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
      if (!verify(null, Buffer.from(signatureBase), key.key, parseSignature(signature))) {
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
  const match = INPUT_PATTERN.exec(value);
  const groups = match?.groups;
  if (groups === undefined) throw failure('SIGNATURE_INPUT_INVALID', 'The TAP Signature-Input field is invalid.');
  const componentsValue = requiredGroup(groups, 'components');
  const components = [...componentsValue.matchAll(/"([a-z@-]+)"/g)].map((component) => component[1]).filter(isString);
  if (components.length === 0 || new Set(components).size !== components.length) {
    throw failure('SIGNATURE_INPUT_INVALID', 'The TAP covered components are invalid.');
  }
  const algorithm = requiredGroup(groups, 'algorithm');
  if (!SUPPORTED_ALGORITHMS.has(algorithm)) {
    throw failure('SIGNATURE_INPUT_INVALID', 'The TAP signature algorithm is invalid.');
  }
  const parameters = value.slice('sig2='.length);
  return {
    components,
    created: Number(requiredGroup(groups, 'created')),
    expires: Number(requiredGroup(groups, 'expires')),
    keyid: requiredGroup(groups, 'keyid'),
    algorithm: 'ed25519',
    nonce: requiredGroup(groups, 'nonce'),
    tag: requiredGroup(groups, 'tag') as ParsedInput['tag'],
    parameters,
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
  const contentType = optionalHeader(request.headers, 'content-type');
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

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function requiredGroup(groups: Record<string, string | undefined>, name: string): string {
  const value = groups[name];
  if (value === undefined) throw failure('SIGNATURE_INPUT_INVALID', 'The TAP Signature-Input field is invalid.');
  return value;
}
