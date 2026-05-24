/**
 * Smoke test for the package's public entry point. Imports from `src/index.ts` (not the underlying source files) so the
 * re-export module is actually loaded by the test runner, and asserts that every documented public symbol is present
 * and of the expected runtime kind.
 *
 * Doubles as a regression check: removing or renaming an export at the entry point breaks this test. Drives
 * `src/index.ts` to 100% line coverage.
 */
import { describe, expect, it } from 'vitest';

import * as seller from '../../src/index.js';

describe('@inflowpayai/x402-seller — public surface', () => {
  it('exposes the facilitator factories', () => {
    expect(typeof seller.createInflowFacilitator).toBe('function');
    expect(typeof seller.createUnauthenticatedInflowFacilitator).toBe('function');
  });

  it('exposes the seller client factory', () => {
    expect(typeof seller.createInflowSellerClient).toBe('function');
  });

  it('exposes the accepts helper', () => {
    expect(typeof seller.inflowAccepts).toBe('function');
  });

  it('exposes the scheme-registration helper', () => {
    expect(typeof seller.inflowSchemeRegistrations).toBe('function');
  });

  it('exposes the typed error class', () => {
    expect(typeof seller.X402PriceParseError).toBe('function');
  });
});
