import { createPublicKey } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { TapVerificationError } from './errors.js';
import type { TapKeyResolver, TapKeyResolverOptions, TapPublicKey } from './types.js';

const VISA_KEYS_URL = 'https://mcp.visa.com/.well-known/jwks';

interface JsonWebKeySet {
  readonly keys?: readonly JsonWebKey[];
}

export class VisaTapKeyResolver implements TapKeyResolver {
  readonly #url: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #cacheTtlMs: number;
  readonly #cacheMaxAgeMs: number;
  readonly #timeoutMs: number;
  readonly #clock: () => number;
  #cache = new Map<string, TapPublicKey>();
  readonly #missing = new Set<string>();
  #cacheUpdated: number | undefined;
  #refresh: Promise<void> | undefined;

  constructor(options: TapKeyResolverOptions = {}) {
    this.#url = new URL(options.url ?? VISA_KEYS_URL);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#cacheTtlMs = options.cacheTtlMs ?? 3_600_000;
    this.#cacheMaxAgeMs = options.cacheMaxAgeMs ?? 86_400_000;
    this.#timeoutMs = options.timeoutMs ?? 3_000;
    this.#clock = options.clock ?? Date.now;
  }

  async resolve(keyid: string, algorithm: string): Promise<TapPublicKey | undefined> {
    if (algorithm !== 'ed25519') return undefined;
    if (this.#cacheUpdated !== undefined && this.#clock() - this.#cacheUpdated <= this.#cacheTtlMs) {
      const cached = this.#cache.get(keyid);
      if (cached !== undefined || this.#missing.has(keyid)) return cached;
    }
    try {
      await this.#refreshKeys();
      const resolved = this.#cache.get(keyid);
      if (resolved === undefined) this.#missing.add(keyid);
      return resolved;
    } catch (cause) {
      if (this.#cacheUpdated !== undefined && this.#clock() - this.#cacheUpdated <= this.#cacheMaxAgeMs) {
        const cached = this.#cache.get(keyid);
        if (cached !== undefined) return cached;
      }
      throw new TapVerificationError('KEY_RETRIEVAL_FAILED', 'The TAP verification key could not be retrieved.', {
        cause,
      });
    }
  }

  async #refreshKeys(): Promise<void> {
    if (this.#refresh !== undefined) return this.#refresh;
    this.#refresh = this.#loadKeys();
    try {
      await this.#refresh;
    } finally {
      this.#refresh = undefined;
    }
  }

  async #loadKeys(): Promise<void> {
    const response = await this.#fetch(this.#url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`Key service returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    if (!isKeySet(payload)) throw new Error('Key service returned an invalid key set.');
    const next = new Map<string, TapPublicKey>();
    for (const jwk of payload.keys ?? []) {
      if (!isTapKey(jwk)) continue;
      const keyid = jwk['kid'];
      if (next.has(keyid)) throw new Error('Key service returned a duplicate key identifier.');
      next.set(keyid, {
        keyid,
        algorithm: 'ed25519',
        key: createPublicKey({ key: jwk, format: 'jwk' }),
      });
    }
    this.#cache = next;
    this.#missing.clear();
    this.#cacheUpdated = this.#clock();
  }
}

function isKeySet(value: unknown): value is JsonWebKeySet {
  return typeof value === 'object' && value !== null && (!('keys' in value) || Array.isArray(value.keys));
}

function isTapKey(key: JsonWebKey): key is JsonWebKey & { readonly kid: string } {
  return (
    typeof key['kid'] === 'string' &&
    typeof key['alg'] === 'string' &&
    (key['alg'] === 'ed25519' || key['alg'] === 'Ed25519') &&
    key.kty === 'OKP' &&
    key.crv === 'Ed25519' &&
    (key['use'] === undefined || key['use'] === 'sig')
  );
}
