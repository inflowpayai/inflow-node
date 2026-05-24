import { describe, expect, it } from 'vitest';

import { parseEvmPrivateKey } from '../../src/decode-evm-key.js';
import { X402InvalidEvmKeyError } from '../../src/errors.js';

const VALID_64_LOWER = 'aa'.repeat(32);
const VALID_64_UPPER = 'AA'.repeat(32);
// First byte 0x80 → BigInteger pads with a leading 00 sign byte.
const JAVA_SIGN_BYTE = '00' + '80' + 'aa'.repeat(31);
// Top 6 bytes are 0 → BigInteger strips them, leaving a 52-char string.
const JAVA_SHORT = 'cd' + 'ef'.repeat(25);

describe('parseEvmPrivateKey — industry-standard inputs', () => {
  it('accepts 0x-prefixed lowercase 64-char hex', () => {
    expect(parseEvmPrivateKey(`0x${VALID_64_LOWER}`)).toBe(`0x${VALID_64_LOWER}`);
  });

  it('accepts 0x-prefixed uppercase hex and lowercases it', () => {
    expect(parseEvmPrivateKey(`0x${VALID_64_UPPER}`)).toBe(`0x${VALID_64_LOWER}`);
  });

  it('accepts bare 64-char hex (no 0x prefix)', () => {
    expect(parseEvmPrivateKey(VALID_64_LOWER)).toBe(`0x${VALID_64_LOWER}`);
  });

  it('trims surrounding whitespace', () => {
    expect(parseEvmPrivateKey(`  0x${VALID_64_LOWER}\n`)).toBe(`0x${VALID_64_LOWER}`);
  });
});

describe('parseEvmPrivateKey — InFlow Java seed shapes', () => {
  it('strips the BigInteger sign byte from a 66-char "00..."-prefixed hex', () => {
    expect(parseEvmPrivateKey(JAVA_SIGN_BYTE)).toBe(`0x${JAVA_SIGN_BYTE.slice(2)}`);
    expect(parseEvmPrivateKey(JAVA_SIGN_BYTE).length).toBe(66); // 0x + 64 hex chars
  });

  it('handles the 0x-prefixed BigInteger sign-byte form', () => {
    expect(parseEvmPrivateKey(`0x${JAVA_SIGN_BYTE}`)).toBe(`0x${JAVA_SIGN_BYTE.slice(2)}`);
  });

  it('left-pads short hex (BigInteger stripped leading zero bytes)', () => {
    const out = parseEvmPrivateKey(JAVA_SHORT);
    expect(out.length).toBe(66);
    expect(out).toBe(`0x${'0'.repeat(64 - JAVA_SHORT.length)}${JAVA_SHORT}`);
  });

  it('does not strip a `00` sign byte from inputs that are not 66 chars', () => {
    // A bare 64-char hex starting with 00 is a legitimate normal-form key
    // (top byte = 0x00); the sign-byte heuristic must not touch it.
    const key = '00' + 'ab'.repeat(31);
    expect(parseEvmPrivateKey(key)).toBe(`0x${key}`);
    expect(parseEvmPrivateKey(key).length).toBe(66);
  });
});

describe('parseEvmPrivateKey — invalid inputs', () => {
  it('throws X402InvalidEvmKeyError on an empty string', () => {
    expect(() => parseEvmPrivateKey('')).toThrowError(X402InvalidEvmKeyError);
  });

  it('throws X402InvalidEvmKeyError on whitespace-only input', () => {
    expect(() => parseEvmPrivateKey('   ')).toThrowError(X402InvalidEvmKeyError);
  });

  it('throws X402InvalidEvmKeyError on non-hex characters', () => {
    expect(() => parseEvmPrivateKey('zzzz' + 'aa'.repeat(30))).toThrowError(X402InvalidEvmKeyError);
  });

  it('throws X402InvalidEvmKeyError on a hex string longer than 33 bytes', () => {
    // 35 bytes = 70 hex chars; not a Java sign-byte (66 chars), so it
    // falls through to the length check at the end.
    const tooLong = 'ab'.repeat(35);
    expect(() => parseEvmPrivateKey(tooLong)).toThrowError(X402InvalidEvmKeyError);
  });

  it('throws X402InvalidEvmKeyError on a 65-char (odd) hex string', () => {
    // 65 chars normalize-pads to 66 (even-length padding), still not 64
    // — and the sign-byte heuristic ignores it because 65 != 66.
    const odd = 'a'.repeat(65);
    expect(() => parseEvmPrivateKey(odd)).toThrowError(X402InvalidEvmKeyError);
  });

  it('exposes a reason describing the failure but does not preserve the raw input', () => {
    try {
      parseEvmPrivateKey('not-hex');
    } catch (err) {
      expect(err).toBeInstanceOf(X402InvalidEvmKeyError);
      const e = err as X402InvalidEvmKeyError;
      // The raw input is intentionally not retained — it can be real key
      // material in a different encoding. `reason` is safe.
      expect(e).not.toHaveProperty('input');
      expect(e.reason).toMatch(/hex characters/u);
      expect(e.name).toBe('X402InvalidEvmKeyError');
      expect(e.message).toMatch(/Invalid EVM private key/u);
      expect(e.message).not.toContain('not-hex');
      return;
    }
    throw new Error('expected throw');
  });
});
