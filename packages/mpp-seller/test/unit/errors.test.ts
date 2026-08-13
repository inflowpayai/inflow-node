import { describe, expect, it } from 'vitest';

import type { MppProblemDetail } from '@inflowpayai/mpp';

import { MppRedeemProblemError, MppUnsupportedCurrencyError } from '../../src/errors.js';

describe('MppRedeemProblemError', () => {
  it('reflects the server problem and renders RFC 9457 details with challengeId + extensions', () => {
    const error = new MppRedeemProblemError({
      type: 'https://paymentauth.org/problems/payment-insufficient',
      title: 'Payment Insufficient',
      status: 402,
      detail: 'too low',
      extensions: { shortfall: '5' },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(402);
    expect(error.type).toBe('https://paymentauth.org/problems/payment-insufficient');
    expect(error.problem.title).toBe('Payment Insufficient');
    expect(error.toProblemDetails('chal-1')).toEqual({
      type: 'https://paymentauth.org/problems/payment-insufficient',
      title: 'Payment Insufficient',
      status: 402,
      detail: 'too low',
      challengeId: 'chal-1',
      shortfall: '5',
    });
  });

  it('does not let extension keys overwrite canonical problem fields or framework fields', () => {
    const error = new MppRedeemProblemError({
      type: 'https://paymentauth.org/problems/payment-insufficient',
      title: 'Payment Insufficient',
      status: 402,
      detail: 'too low',
      hint: 'add funds first',
      details: { provider: 'inflow' },
      extensions: {
        type: 'spoofed',
        title: 'Spoofed',
        detail: 'spoofed',
        status: 500,
        hint: 'spoofed',
        details: { provider: 'evil' },
        challengeId: 'spoofed-id',
        custom: 'kept',
      },
    });
    const problem = error.toProblemDetails('chal-2');
    expect(problem).toEqual({
      type: 'https://paymentauth.org/problems/payment-insufficient',
      title: 'Payment Insufficient',
      status: 402,
      detail: 'too low',
      hint: 'add funds first',
      details: { provider: 'inflow' },
      challengeId: 'chal-2',
      custom: 'kept',
    });
  });

  it('omits challengeId and extensions when absent', () => {
    const error = new MppRedeemProblemError({
      type: 'https://paymentauth.org/problems/verification-failed',
      title: 'Verification Failed',
      status: 402,
      detail: 'nope',
    });
    expect(error.toProblemDetails()).toEqual({
      type: 'https://paymentauth.org/problems/verification-failed',
      title: 'Verification Failed',
      status: 402,
      detail: 'nope',
    });
  });

  it('replaces malformed runtime problem objects instead of retaining raw extensions', () => {
    const malformed = JSON.parse(
      '{"type":42,"title":null,"status":"402","detail":{"message":"bad"},"extensions":{"__proto__":{"polluted":true},"constructor":"spoofed","custom":"must-not-survive"}}',
    ) as MppProblemDetail;

    const error = new MppRedeemProblemError(malformed);

    expect(error.toProblemDetails()).toEqual({
      type: 'https://paymentauth.org/problems/verification-failed',
      title: 'Payment Verification Failed',
      status: 402,
      detail: 'The PSP redeem response carried a malformed problem.',
    });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('sanitizes prototype-mutating and oversized diagnostic fields', () => {
    const details = JSON.parse(
      '{"provider":"inflow","nested":{"__proto__":{"polluted":true},"safe":"kept"}}',
    ) as Record<string, unknown>;
    const extensions = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"spoofed","prototype":"spoofed","custom":"kept","nested":{"__proto__":{"polluted":true},"safe":"kept"}}',
    ) as Record<string, unknown>;
    const error = new MppRedeemProblemError({
      type: 'https://paymentauth.org/problems/verification-failed',
      title: 'Verification Failed',
      status: 402,
      detail: 'nope',
      hint: 'x'.repeat(2_049),
      details,
      extensions,
    });

    const problem = error.toProblemDetails();
    expect(problem).toEqual({
      type: 'https://paymentauth.org/problems/verification-failed',
      title: 'Verification Failed',
      status: 402,
      detail: 'nope',
      details: { provider: 'inflow', nested: { safe: 'kept' } },
      custom: 'kept',
      nested: { safe: 'kept' },
    });
    expect(Object.hasOwn(problem, '__proto__')).toBe(false);
    expect(Object.hasOwn(error.problem.details?.['nested'] as object, '__proto__')).toBe(false);
    expect(JSON.stringify(problem)).not.toContain('"__proto__"');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('drops invalid, deeply nested, or over-budget extension values', () => {
    let deeplyNested: Record<string, unknown> = { safe: 'bottom' };
    for (let depth = 0; depth < 18; depth += 1) deeplyNested = { nested: deeplyNested };
    const overBudget = Array.from({ length: 257 }, () => 'value');
    const problems = [
      new MppRedeemProblemError({
        type: 'https://paymentauth.org/problems/verification-failed',
        title: 'Verification Failed',
        status: 402,
        detail: 'nope',
        extensions: { invalid: Number.NaN },
      }),
      new MppRedeemProblemError({
        type: 'https://paymentauth.org/problems/verification-failed',
        title: 'Verification Failed',
        status: 402,
        detail: 'nope',
        extensions: { deeplyNested },
      }),
      new MppRedeemProblemError({
        type: 'https://paymentauth.org/problems/verification-failed',
        title: 'Verification Failed',
        status: 402,
        detail: 'nope',
        extensions: { overBudget },
      }),
    ];

    for (const error of problems) {
      expect(error.toProblemDetails()).toEqual({
        type: 'https://paymentauth.org/problems/verification-failed',
        title: 'Verification Failed',
        status: 402,
        detail: 'nope',
      });
    }
  });
});

describe('MppUnsupportedCurrencyError', () => {
  it('carries the offending currency in the field and message', () => {
    const error = new MppUnsupportedCurrencyError('JPY');
    expect(error).toBeInstanceOf(Error);
    expect(error.currency).toBe('JPY');
    expect(error.message).toContain('JPY');
  });
});
