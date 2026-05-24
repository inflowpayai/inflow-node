import { describe, expect, it } from 'vitest';

import { getExtra, setExtra } from '../../src/extras/access.js';

describe('getExtra', () => {
  it('returns undefined for an undefined extra map', () => {
    expect(getExtra(undefined, 'name')).toBeUndefined();
  });

  it('returns undefined for a missing key', () => {
    expect(getExtra({ a: 1 }, 'b')).toBeUndefined();
  });

  it('returns the raw value when present', () => {
    expect(getExtra<string>({ name: 'USDC' }, 'name')).toBe('USDC');
  });

  it('returns the value at the requested generic type without runtime checking', () => {
    const result = getExtra<number>({ count: 5 }, 'count');
    expect(result).toBe(5);
  });
});

describe('setExtra', () => {
  it('writes a new key and returns a new object', () => {
    const before: Record<string, unknown> = { a: 1 };
    const after = setExtra(before, 'b', 2);
    expect(after).toEqual({ a: 1, b: 2 });
    expect(after).not.toBe(before);
    expect(before).toEqual({ a: 1 });
  });

  it('overwrites an existing key', () => {
    expect(setExtra({ a: 1 }, 'a', 2)).toEqual({ a: 2 });
  });

  it('treats undefined input as empty', () => {
    expect(setExtra(undefined, 'a', 1)).toEqual({ a: 1 });
  });
});
