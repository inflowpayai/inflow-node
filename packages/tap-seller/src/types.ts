import type { KeyObject } from 'node:crypto';

export type TapIntent = 'browse' | 'pay';

export interface TapRequest {
  readonly method: string;
  readonly url: string | URL;
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body?: Uint8Array | string;
}

export interface TapVerificationFacts {
  readonly verified: true;
  readonly keyid: string;
  readonly algorithm: 'ed25519';
  readonly intent: TapIntent;
  readonly nonce: string;
  readonly created: number;
  readonly expires: number;
  readonly coveredComponents: readonly string[];
}

export interface TapPublicKey {
  readonly keyid: string;
  readonly algorithm: 'ed25519';
  readonly key: KeyObject;
}

export interface TapKeyResolver {
  resolve(keyid: string, algorithm: string): Promise<TapPublicKey | undefined>;
}

export interface TapReplayStore {
  claim(keyid: string, nonce: string, expires: number): boolean | Promise<boolean>;
}

export interface TapVerifierOptions {
  readonly keyResolver?: TapKeyResolver;
  readonly replayStore?: TapReplayStore;
  readonly clock?: () => number;
}

export interface TapKeyResolverOptions {
  readonly url?: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly cacheTtlMs?: number;
  readonly cacheMaxAgeMs?: number;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

export interface TapVerifier {
  verify(request: TapRequest): Promise<TapVerificationFacts>;
}

export type TapVerifiedHandler<T> = (facts: TapVerificationFacts) => T | Promise<T>;

export type TapMiddleware = <T>(request: TapRequest, next: TapVerifiedHandler<T>) => Promise<T>;
