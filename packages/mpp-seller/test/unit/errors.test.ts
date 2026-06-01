import { describe, expect, it } from 'vitest';

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
});

describe('MppUnsupportedCurrencyError', () => {
  it('carries the offending currency in the field and message', () => {
    const error = new MppUnsupportedCurrencyError('JPY');
    expect(error).toBeInstanceOf(Error);
    expect(error.currency).toBe('JPY');
    expect(error.message).toContain('JPY');
  });
});
