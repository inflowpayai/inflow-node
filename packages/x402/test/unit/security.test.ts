import { describe, expect, it } from 'vitest';

import { timingSafeEqualStrings } from '../../src/security/index.js';

describe('timingSafeEqualStrings', () => {
  it('returns true for equal ASCII strings', () => {
    expect(timingSafeEqualStrings('pay_abc', 'pay_abc')).toBe(true);
  });

  it('returns false for strings of different length', () => {
    expect(timingSafeEqualStrings('a', 'ab')).toBe(false);
  });

  it('returns false for same-length strings that differ', () => {
    expect(timingSafeEqualStrings('abcd', 'abce')).toBe(false);
  });

  it('handles multi-byte UTF-8 sequences', () => {
    expect(timingSafeEqualStrings('héllo', 'héllo')).toBe(true);
    expect(timingSafeEqualStrings('héllo', 'hella')).toBe(false);
  });

  it('returns false for any non-string input', () => {
    expect(timingSafeEqualStrings(undefined, undefined)).toBe(false);
    expect(timingSafeEqualStrings(null, '')).toBe(false);
    expect(timingSafeEqualStrings(123, '123')).toBe(false);
    expect(timingSafeEqualStrings('123', 123)).toBe(false);
    expect(timingSafeEqualStrings({}, {})).toBe(false);
  });

  it('treats two empty strings as equal', () => {
    expect(timingSafeEqualStrings('', '')).toBe(true);
  });
});
