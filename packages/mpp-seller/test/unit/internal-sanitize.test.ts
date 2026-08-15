import { describe, expect, it } from 'vitest';

import { isPlainRecord, sanitizeJsonValue } from '@inflowpayai/mpp-internal';

describe('shared sanitizer utilities', () => {
  it('supports the private workspace import and strips unsafe object keys', () => {
    const raw = JSON.parse(
      '{"chainId":1001,"__proto__":{"polluted":true},"extension":{"constructor":"spoofed","safe":"kept","nested":{"prototype":"spoofed"}}}',
    ) as unknown;
    const sanitized = sanitizeJsonValue(raw, 0, { entries: 256 }, 16);
    expect(isPlainRecord(sanitized)).toBe(true);
    expect(sanitized).toEqual({
      chainId: 1001,
      extension: { safe: 'kept', nested: {} },
    });
  });
});
