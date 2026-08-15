import { describe, expect, it } from 'vitest';

import { isPlainRecord, sanitizeJsonValue, sanitizeMppProblemDetail } from '@inflowpayai/mpp-internal';

describe('shared JSON sanitizer', () => {
  it('removes prototype keys and preserves primitive JSON values', () => {
    const raw = JSON.parse(
      '{"ok":1,"nested":{"safe":true,"__proto__":{"polluted":true},"nested":["value",1,true,{"constructor":"spoofed","safe":false}]}}',
    ) as unknown;
    const sanitized = sanitizeJsonValue(raw, 0, { entries: 256 }, 16);
    if (!isPlainRecord(sanitized)) throw new Error('expected plain object result');

    expect(sanitized['ok']).toBe(1);
    const nested = sanitized['nested'];
    if (!isPlainRecord(nested)) throw new Error('expected nested object result');
    expect(nested).toEqual({
      safe: true,
      nested: ['value', 1, true, { safe: false }],
    });
  });

  it('rejects non-finite numbers, over-budget structures, and deep recursion', () => {
    expect(sanitizeJsonValue(Number.POSITIVE_INFINITY, 0, { entries: 256 }, 16)).toBeUndefined();

    let deep: { [key: string]: unknown } = { safe: 'bottom' };
    for (let depth = 0; depth < 18; depth += 1) {
      deep = { nested: deep };
    }
    expect(sanitizeJsonValue(deep, 0, { entries: 256 }, 16)).toBeUndefined();

    expect(
      sanitizeJsonValue({ overBudget: Array.from({ length: 257 }, () => 'value') }, 0, { entries: 256 }, 16),
    ).toBeUndefined();
  });

  it('sanitizes MPP problem wrapper bodies with extension-key filtering and prototype-key removal', () => {
    const body = {
      problem: {
        type: 'https://paymentauth.org/problems/payment-required',
        title: 'Payment Required',
        status: 402,
        detail: 'payment required',
        hint: 'please fix',
        details: {
          provider: 'inflow',
          nested: JSON.parse('{"__proto__":{"polluted":true},"safe":"kept"}') as Record<string, unknown>,
        },
        extensions: {
          type: 'bad',
          instance: '/problems/spoofed',
          challengeId: 'spoofed',
          custom: 'kept',
          nested: JSON.parse('{"__proto__":{"polluted":true},"safe":"kept"}') as Record<string, unknown>,
          constructor: 'bad',
        },
      },
    } as const;
    const problem = sanitizeMppProblemDetail(body);
    expect(problem).toEqual({
      type: 'https://paymentauth.org/problems/payment-required',
      title: 'Payment Required',
      status: 402,
      detail: 'payment required',
      hint: 'please fix',
      details: { provider: 'inflow', nested: { safe: 'kept' } },
      extensions: { custom: 'kept', nested: { safe: 'kept' } },
    });
    expect(Object.hasOwn(problem?.extensions?.['nested'] as object, '__proto__')).toBe(false);
  });

  it('omits oversized hints and invalid problem details during extraction', () => {
    const body = {
      type: 'https://paymentauth.org/problems/payment-required',
      title: 'Payment Required',
      status: 402,
      detail: 'payment required',
      hint: 'x'.repeat(2_049),
      details: ['not', 'a', 'record'],
    } as const;
    const problem = sanitizeMppProblemDetail(body);
    expect(problem).toEqual({
      type: 'https://paymentauth.org/problems/payment-required',
      title: 'Payment Required',
      status: 402,
      detail: 'payment required',
    });
  });

  it('rejects oversized required strings and keeps safe siblings when one diagnostic value is invalid', () => {
    expect(
      sanitizeMppProblemDetail({
        type: 'https://paymentauth.org/problems/payment-required',
        title: 'x'.repeat(513),
        status: 402,
        detail: 'payment required',
      }),
    ).toBeUndefined();

    expect(
      sanitizeMppProblemDetail({
        type: 'https://paymentauth.org/problems/payment-required',
        title: 'Payment Required',
        status: 402,
        detail: 'payment required',
        details: { safe: 'kept', invalid: Number.NaN },
        extensions: { safe: 'kept', invalid: Number.NaN },
      }),
    ).toEqual({
      type: 'https://paymentauth.org/problems/payment-required',
      title: 'Payment Required',
      status: 402,
      detail: 'payment required',
      details: { safe: 'kept' },
      extensions: { safe: 'kept' },
    });
  });
});
