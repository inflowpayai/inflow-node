import { describe, expect, it } from 'vitest';

import {
  MppMalformedCredentialError,
  MppPaymentCancelledError,
  MppPaymentExpiredError,
  MppPaymentFailedError,
  MppPaymentTimeoutError,
} from '../../src/errors.js';

describe('typed errors', () => {
  it('MppPaymentCancelledError carries the approvalId when known, and reads cleanly without one', () => {
    expect(new MppPaymentCancelledError('ap-1').approvalId).toBe('ap-1');
    expect(new MppPaymentCancelledError().approvalId).toBeUndefined();
    expect(new MppPaymentCancelledError('ap-1').message).toContain('ap-1');
  });

  it('MppPaymentFailedError prefers the problem detail/title for its message', () => {
    const withDetail = new MppPaymentFailedError({
      type: 't',
      title: 'Title',
      status: 402,
      detail: 'the detail',
    });
    expect(withDetail.problem?.detail).toBe('the detail');
    expect(withDetail.message).toContain('the detail');
    expect(new MppPaymentFailedError().message).toBe('MPP payment failed');
  });

  it('MppPaymentExpiredError carries the transactionId when known', () => {
    expect(new MppPaymentExpiredError('tx-1').transactionId).toBe('tx-1');
    expect(new MppPaymentExpiredError().transactionId).toBeUndefined();
  });

  it('MppPaymentTimeoutError carries the budget and transactionId', () => {
    const withId = new MppPaymentTimeoutError(1234, 'tx-2');
    expect(withId.timeoutMs).toBe(1234);
    expect(withId.transactionId).toBe('tx-2');
    expect(withId.message).toContain('1234');
    expect(new MppPaymentTimeoutError(50).transactionId).toBeUndefined();
  });

  it('MppMalformedCredentialError wraps a cause and prefixes the message', () => {
    const err = new MppMalformedCredentialError('bad', new Error('boom'));
    expect(err.message).toContain('bad');
    expect(err.cause).toBeInstanceOf(Error);
    expect(new MppMalformedCredentialError('bad').cause).toBeUndefined();
  });
});
