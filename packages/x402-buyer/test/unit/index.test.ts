/**
 * Smoke test for the package's public entry point. Imports from `src/index.ts` (not the underlying source files) so the
 * re-export module is actually loaded by the test runner, and asserts that every documented public symbol is present.
 *
 * Doubles as a regression check: removing or renaming an export at the entry point breaks this test.
 */
import { describe, expect, it } from 'vitest';

import * as buyer from '../../src/index.js';

describe('@inflowpayai/x402-buyer — public surface', () => {
  it('exposes InflowClient and its factory', () => {
    expect(typeof buyer.InflowClient).toBe('function');
    expect(typeof buyer.createInflowClient).toBe('function');
  });

  it('exposes the key-decoding helpers', () => {
    expect(typeof buyer.parseEvmPrivateKey).toBe('function');
    expect(typeof buyer.decodeSolanaSecret).toBe('function');
  });

  it('exposes the foundation→InFlow requirements bridge', () => {
    expect(typeof buyer.fromFoundationRequirements).toBe('function');
    const sample = [
      {
        scheme: 'balance',
        network: 'inflow:1',
        asset: '',
        amount: '0',
        payTo: '',
        maxTimeoutSeconds: 0,
        extra: {},
      },
    ] as const;
    const result = buyer.fromFoundationRequirements(sample);
    expect(result).toBe(sample);
    expect(result[0]?.network).toBe('inflow:1');
  });

  it('exposes every typed error class', () => {
    expect(typeof buyer.X402AdapterRoutingError).toBe('function');
    expect(typeof buyer.X402ApprovalCancelledError).toBe('function');
    expect(typeof buyer.X402ApprovalFailedError).toBe('function');
    expect(typeof buyer.X402ApprovalTimeoutError).toBe('function');
    expect(typeof buyer.X402InvalidEvmKeyError).toBe('function');
    expect(typeof buyer.X402InvalidSolanaKeyError).toBe('function');
    expect(typeof buyer.X402PaymentIdFormatError).toBe('function');
  });
});
