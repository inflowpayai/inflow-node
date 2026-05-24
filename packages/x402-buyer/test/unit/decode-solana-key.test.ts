import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { decodeSolanaSecret } from '../../src/decode-solana-key.js';
import { X402InvalidSolanaKeyError } from '../../src/errors.js';

/**
 * Deterministic 64-byte Ed25519 secret key fixture used across the tests. The bytes themselves are arbitrary — what
 * matters is that round-tripping through base58 / JSON-array recovers the exact same sequence of 64 bytes.
 */
function fixtureBytes(): Uint8Array {
  const buf = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) buf[i] = i;
  return buf;
}

describe('decodeSolanaSecret — base58 (InFlow SolanaClient.Account.getSeed() shape)', () => {
  it('round-trips a fixed 64-byte buffer through base58', () => {
    const expected = fixtureBytes();
    const encoded = bs58.encode(expected);
    const decoded = decodeSolanaSecret(encoded);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded.length).toBe(64);
    expect(Array.from(decoded)).toEqual(Array.from(expected));
  });

  it('tolerates surrounding whitespace on base58 input', () => {
    const expected = fixtureBytes();
    const encoded = `  ${bs58.encode(expected)}\n`;
    const decoded = decodeSolanaSecret(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(expected));
  });

  it('throws X402InvalidSolanaKeyError when base58 decodes to the wrong length', () => {
    // 32 bytes of zeros — valid base58, valid encoding, but wrong size.
    const encoded = bs58.encode(new Uint8Array(32));
    expect(() => decodeSolanaSecret(encoded)).toThrowError(X402InvalidSolanaKeyError);
  });

  it('throws X402InvalidSolanaKeyError on malformed base58', () => {
    // `0`, `O`, `I`, `l` are NOT in the base58 alphabet.
    expect(() => decodeSolanaSecret('0OIl')).toThrowError(X402InvalidSolanaKeyError);
  });
});

describe('decodeSolanaSecret — JSON byte array (solana-keygen shape)', () => {
  it('decodes a well-formed JSON array of 64 ints', () => {
    const expected = fixtureBytes();
    const encoded = JSON.stringify(Array.from(expected));
    const decoded = decodeSolanaSecret(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(expected));
  });

  it('tolerates surrounding whitespace on JSON array input', () => {
    const expected = fixtureBytes();
    const encoded = `\n  ${JSON.stringify(Array.from(expected))}  `;
    const decoded = decodeSolanaSecret(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(expected));
  });

  it('throws X402InvalidSolanaKeyError on a JSON array of the wrong length', () => {
    const tooShort = JSON.stringify(new Array(32).fill(0));
    expect(() => decodeSolanaSecret(tooShort)).toThrowError(X402InvalidSolanaKeyError);
  });

  it('throws X402InvalidSolanaKeyError on out-of-range integers', () => {
    const arr = new Array(64).fill(0) as number[];
    arr[0] = 256;
    expect(() => decodeSolanaSecret(JSON.stringify(arr))).toThrowError(X402InvalidSolanaKeyError);
  });

  it('throws X402InvalidSolanaKeyError on non-integer JSON elements', () => {
    const arr = new Array(64).fill(0) as unknown[];
    arr[0] = 'not-a-number';
    expect(() => decodeSolanaSecret(JSON.stringify(arr))).toThrowError(X402InvalidSolanaKeyError);
  });

  it('throws X402InvalidSolanaKeyError on malformed JSON', () => {
    expect(() => decodeSolanaSecret('[1, 2, 3,')).toThrowError(X402InvalidSolanaKeyError);
  });
});

describe('decodeSolanaSecret — empty / shape errors', () => {
  it('throws X402InvalidSolanaKeyError on an empty string', () => {
    expect(() => decodeSolanaSecret('')).toThrowError(X402InvalidSolanaKeyError);
  });

  it('throws X402InvalidSolanaKeyError on whitespace-only input', () => {
    expect(() => decodeSolanaSecret('   \n')).toThrowError(X402InvalidSolanaKeyError);
  });

  it('exposes a reason describing the failure but does not preserve the raw input', () => {
    try {
      decodeSolanaSecret('0OIl');
    } catch (err) {
      expect(err).toBeInstanceOf(X402InvalidSolanaKeyError);
      const e = err as X402InvalidSolanaKeyError;
      // The raw input is intentionally not retained — it can be real key
      // material with a single mistyped base58 character. `reason` is safe.
      expect(e).not.toHaveProperty('input');
      expect(e.name).toBe('X402InvalidSolanaKeyError');
      expect(e.reason).toMatch(/base58/u);
      expect(e.message).toMatch(/Invalid Solana private key/u);
      expect(e.message).toMatch(/64-byte Ed25519 secret key/u);
      expect(e.message).not.toContain('0OIl');
      return;
    }
    throw new Error('expected throw');
  });
});
