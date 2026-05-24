import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getExtension, setExtension } from '../../src/extensions/access.js';
import {
  EXTENSION_PAYMENT_IDENTIFIER,
  EXTENSION_REGISTRY,
  PAYMENT_ID_DEFAULT_PREFIX,
  PAYMENT_ID_MAX_LENGTH,
  PAYMENT_ID_MIN_LENGTH,
  PAYMENT_ID_REGEX,
  PAYMENT_IDENTIFIER,
  generatePaymentId,
  validatePaymentId,
} from '../../src/extensions/index.js';

describe('validatePaymentId', () => {
  it('accepts ids of minimum length consisting of allowed chars', () => {
    expect(validatePaymentId('a'.repeat(PAYMENT_ID_MIN_LENGTH))).toBe(true);
  });

  it('accepts ids of maximum length', () => {
    expect(validatePaymentId('a'.repeat(PAYMENT_ID_MAX_LENGTH))).toBe(true);
  });

  it('accepts mixed allowed characters', () => {
    expect(validatePaymentId('pay_abcDEF-0123_4567')).toBe(true);
  });

  it('rejects ids shorter than minimum length', () => {
    expect(validatePaymentId('a'.repeat(PAYMENT_ID_MIN_LENGTH - 1))).toBe(false);
  });

  it('rejects ids longer than maximum length', () => {
    expect(validatePaymentId('a'.repeat(PAYMENT_ID_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejects ids containing disallowed characters', () => {
    expect(validatePaymentId('aaaaaaaaaaaaaaaaa!')).toBe(false);
    expect(validatePaymentId('aaaaaaaaaaaaaaaaa ')).toBe(false);
    expect(validatePaymentId('aaaaaaaaaaaaaaaaa/')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(validatePaymentId(undefined)).toBe(false);
    expect(validatePaymentId(123)).toBe(false);
    expect(validatePaymentId({})).toBe(false);
    expect(validatePaymentId(null)).toBe(false);
  });
});

describe('generatePaymentId', () => {
  it('emits a 36-char id with the default "pay_" prefix', () => {
    const id = generatePaymentId();
    expect(id).toMatch(/^pay_[a-f0-9]{32}$/u);
    expect(id.length).toBe(36);
  });

  it('accepts a custom prefix', () => {
    const id = generatePaymentId('inflow_');
    expect(id.startsWith('inflow_')).toBe(true);
    expect(id.length).toBe('inflow_'.length + 32);
    expect(validatePaymentId(id)).toBe(true);
  });

  it('exposes the default prefix constant', () => {
    expect(PAYMENT_ID_DEFAULT_PREFIX).toBe('pay_');
  });

  // Property test (replaces an earlier 50-iteration for-loop). For any spec-valid prefix, the generated id must:
  //   1. Pass validatePaymentId  (round-trip — the central guarantee callers depend on).
  //   2. Start with the supplied prefix  (so the prefix is usable as a routing / search key).
  //   3. Sit inside [PAYMENT_ID_MIN_LENGTH, PAYMENT_ID_MAX_LENGTH]  (spec compliance).
  //   4. Match PAYMENT_ID_REGEX  (wire compliance — defensively re-checked).
  // Prefix length is capped at 90 so the 32-char random suffix still fits inside the 128-char ceiling; fast-check
  // shrinks toward the empty prefix on failure, which is the most informative counterexample.
  it('round-trips: any spec-valid prefix produces a validatePaymentId-positive id', () => {
    const validPrefix = fc.stringMatching(/^[a-zA-Z0-9_-]{0,90}$/u);
    fc.assert(
      fc.property(validPrefix, (prefix) => {
        const id = generatePaymentId(prefix);
        expect(validatePaymentId(id)).toBe(true);
        expect(id.startsWith(prefix)).toBe(true);
        expect(id.length).toBeGreaterThanOrEqual(PAYMENT_ID_MIN_LENGTH);
        expect(id.length).toBeLessThanOrEqual(PAYMENT_ID_MAX_LENGTH);
        expect(PAYMENT_ID_REGEX.test(id)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  // Negative property: any prefix containing a char outside the allowed set must cause generatePaymentId to throw.
  // The filter discards the (vanishingly small) subset of random ASCII strings that happen to satisfy the regex —
  // fast-check handles dead-end shrinks cleanly.
  it('throws on any prefix containing a char outside the allowed set', () => {
    const invalidPrefix = fc.string({ minLength: 1, maxLength: 32 }).filter((s) => !/^[a-zA-Z0-9_-]*$/u.test(s));
    fc.assert(
      fc.property(invalidPrefix, (prefix) => {
        expect(() => generatePaymentId(prefix)).toThrow();
      }),
    );
  });

  // Explicit boundary cases: the floor and the ceiling. fast-check covers the interior; these pin the edges so a
  // regression that shifts MIN/MAX is impossible to land silently.
  it('produces a 32-char id at the floor (empty prefix → suffix alone)', () => {
    const id = generatePaymentId('');
    expect(id.length).toBe(32);
    expect(id.length).toBeGreaterThanOrEqual(PAYMENT_ID_MIN_LENGTH);
    expect(validatePaymentId(id)).toBe(true);
  });

  it('produces a 128-char id at the ceiling (96-char prefix + 32-char suffix)', () => {
    const id = generatePaymentId('a'.repeat(96));
    expect(id.length).toBe(128);
    expect(id.length).toBe(PAYMENT_ID_MAX_LENGTH);
    expect(validatePaymentId(id)).toBe(true);
  });

  it('throws when the resulting id would exceed the max length by one (97-char prefix)', () => {
    const tooLong = 'a'.repeat(PAYMENT_ID_MAX_LENGTH - 31); // 128 - 31 = 97; 97 + 32 = 129
    expect(() => generatePaymentId(tooLong)).toThrow();
  });
});

describe('PAYMENT_IDENTIFIER handler', () => {
  it('declares the extension name verbatim', () => {
    expect(PAYMENT_IDENTIFIER.name).toBe(EXTENSION_PAYMENT_IDENTIFIER);
    expect(PAYMENT_IDENTIFIER.name).toBe('payment-identifier');
  });

  it('buildDeclaration returns { required: false }', () => {
    expect(PAYMENT_IDENTIFIER.buildDeclaration({})).toEqual({ required: false });
  });

  it('readDeclaration parses a valid wire shape', () => {
    expect(PAYMENT_IDENTIFIER.readDeclaration({ required: true })).toEqual({ required: true });
    expect(PAYMENT_IDENTIFIER.readDeclaration({ required: false })).toEqual({ required: false });
  });

  it('readDeclaration rejects malformed input', () => {
    expect(PAYMENT_IDENTIFIER.readDeclaration(undefined)).toBeNull();
    expect(PAYMENT_IDENTIFIER.readDeclaration(null)).toBeNull();
    expect(PAYMENT_IDENTIFIER.readDeclaration({})).toBeNull();
    expect(PAYMENT_IDENTIFIER.readDeclaration({ required: 'yes' })).toBeNull();
    expect(PAYMENT_IDENTIFIER.readDeclaration('payment-identifier')).toBeNull();
  });

  it('buildPayloadEntry returns null when no payment id is supplied', () => {
    expect(PAYMENT_IDENTIFIER.buildPayloadEntry({ required: false }, {})).toBeNull();
  });

  it('buildPayloadEntry returns the entry when a valid id is supplied', () => {
    const id = generatePaymentId();
    expect(PAYMENT_IDENTIFIER.buildPayloadEntry({ required: false }, { providedPaymentId: id })).toEqual({
      paymentId: id,
    });
  });

  it('buildPayloadEntry rejects an invalid id silently with null', () => {
    expect(PAYMENT_IDENTIFIER.buildPayloadEntry({ required: true }, { providedPaymentId: 'too-short' })).toBeNull();
  });

  it('EXTENSION_REGISTRY includes PAYMENT_IDENTIFIER under its declared name', () => {
    expect(EXTENSION_REGISTRY.get(EXTENSION_PAYMENT_IDENTIFIER)).toBe(PAYMENT_IDENTIFIER);
  });

  it('EXTENSION_REGISTRY maps the name to the handler', () => {
    expect(EXTENSION_REGISTRY.get('payment-identifier')).toBe(PAYMENT_IDENTIFIER);
    expect(EXTENSION_REGISTRY.get('unknown')).toBeUndefined();
  });
});

describe('getExtension / setExtension', () => {
  it('getExtension returns undefined when extensions is undefined', () => {
    expect(getExtension(undefined, PAYMENT_IDENTIFIER)).toBeUndefined();
  });

  it('getExtension returns undefined when the name is absent', () => {
    expect(getExtension({ other: { required: true } }, PAYMENT_IDENTIFIER)).toBeUndefined();
  });

  it('getExtension returns the parsed declaration when present', () => {
    expect(getExtension({ 'payment-identifier': { required: true } }, PAYMENT_IDENTIFIER)).toEqual({ required: true });
  });

  it('getExtension returns undefined when the raw value fails to parse', () => {
    expect(getExtension({ 'payment-identifier': { bogus: 1 } }, PAYMENT_IDENTIFIER)).toBeUndefined();
  });

  it('setExtension writes the entry and returns a new object', () => {
    const original: Record<string, unknown> = { other: 'x' };
    const updated = setExtension(original, PAYMENT_IDENTIFIER, { required: true });
    expect(updated).toEqual({ other: 'x', 'payment-identifier': { required: true } });
    expect(updated).not.toBe(original);
    expect(original).toEqual({ other: 'x' });
  });

  it('setExtension treats undefined input as an empty map', () => {
    expect(setExtension(undefined, PAYMENT_IDENTIFIER, { required: false })).toEqual({
      'payment-identifier': { required: false },
    });
  });
});
