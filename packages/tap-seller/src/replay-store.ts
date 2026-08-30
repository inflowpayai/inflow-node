import type { TapReplayStore } from './types.js';

export class MemoryTapReplayStore implements TapReplayStore {
  readonly #claims = new Map<string, number>();
  readonly #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  claim(keyid: string, nonce: string, expires: number): boolean {
    const now = Math.floor(this.#clock() / 1000);
    for (const [key, expiration] of this.#claims) {
      if (expiration <= now) this.#claims.delete(key);
    }
    const key = `${keyid}\u0000${nonce}`;
    if (this.#claims.has(key)) return false;
    this.#claims.set(key, expires);
    return true;
  }
}
