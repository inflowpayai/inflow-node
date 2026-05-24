import { describe, expect, it } from 'vitest';

import {
  X402AdapterRoutingError,
  X402ApprovalFailedError,
  X402ApprovalTimeoutError,
  X402PaymentIdFormatError,
} from '../../src/errors.js';

describe('X402ApprovalFailedError', () => {
  it('carries approvalId, status, and a standard message', () => {
    const err = new X402ApprovalFailedError('apr_1', 'DECLINED');
    expect(err.name).toBe('X402ApprovalFailedError');
    expect(err.approvalId).toBe('apr_1');
    expect(err.status).toBe('DECLINED');
    expect(err.message).toBe('Approval apr_1 terminated as DECLINED with no payload');
  });
});

describe('X402ApprovalTimeoutError', () => {
  it('carries approvalId, timeoutMs, and a standard message', () => {
    const err = new X402ApprovalTimeoutError('apr_2', 5000);
    expect(err.name).toBe('X402ApprovalTimeoutError');
    expect(err.approvalId).toBe('apr_2');
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toBe('Approval apr_2 not signed within 5000ms');
  });
});

describe('X402PaymentIdFormatError', () => {
  it('carries the offending input and a standard message', () => {
    const err = new X402PaymentIdFormatError('bad id!');
    expect(err.name).toBe('X402PaymentIdFormatError');
    expect(err.input).toBe('bad id!');
    expect(err.message).toMatch(/Invalid paymentId/u);
  });
});

describe('X402AdapterRoutingError', () => {
  it('carries scheme, network, and a standard message', () => {
    const err = new X402AdapterRoutingError('exact', 'eip155:1');
    expect(err.name).toBe('X402AdapterRoutingError');
    expect(err.scheme).toBe('exact');
    expect(err.network).toBe('eip155:1');
    expect(err.message).toMatch(/InflowClient cannot route requirement/u);
    expect(err.message).toMatch(/scheme: "exact"/u);
    expect(err.message).toMatch(/network: "eip155:1"/u);
  });
});
