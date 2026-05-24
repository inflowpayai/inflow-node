/**
 * Smoke tests for the package's public entry points. Each test block imports from one of the four subpaths declared in
 * `package.json#exports` (`.`, `./security`, `./extensions`, `./extras`) via `src/...index.js` so the re-export module
 * is actually loaded by the test runner, and asserts that every documented public symbol is present and of the expected
 * runtime kind.
 *
 * Doubles as a regression check: removing or renaming an export at any entry point breaks this test. Drives
 * `src/index.ts` (and the three subpath index files) to 100% line/branch coverage.
 */
import { describe, expect, it } from 'vitest';

import * as root from '../../src/index.js';
import * as extensions from '../../src/extensions/index.js';
import * as extras from '../../src/extras/index.js';
import * as security from '../../src/security/index.js';

describe('@inflowpayai/x402 — public surface', () => {
  describe('root entry (".")', () => {
    it('exposes the constants module', () => {
      expect(typeof root.ASSET_TRANSFER_METHODS).toBe('object');
      expect(typeof root.CONTRACTS).toBe('object');
      expect(typeof root.EXTRA_KEYS).toBe('object');
      expect(typeof root.HEADERS).toBe('object');
      expect(typeof root.NETWORKS).toBe('object');
      expect(typeof root.PAYLOAD_KEYS).toBe('object');
      expect(typeof root.SCHEMES).toBe('object');
      expect(typeof root.X402_VERSION).toBe('number');
      expect(typeof root.readHeader).toBe('function');
    });

    it('exposes the environment helper', () => {
      expect(typeof root.resolveBaseUrl).toBe('function');
    });

    it('exposes the typed error classes', () => {
      expect(typeof root.InflowApiError).toBe('function');
      expect(typeof root.X402VersionMismatchError).toBe('function');
    });

    it('exposes the HTTP client', () => {
      expect(typeof root.InflowHttpClient).toBe('function');
    });

    it('re-exports the payment-identifier helpers', () => {
      expect(typeof root.generatePaymentId).toBe('function');
      expect(typeof root.validatePaymentId).toBe('function');
    });

    it('exposes the payload discriminators', () => {
      expect(typeof root.isBalancePayload).toBe('function');
      expect(typeof root.isExactPayload).toBe('function');
      expect(typeof root.isInstrumentPayload).toBe('function');
      expect(typeof root.isPermit2Payload).toBe('function');
    });
  });

  describe('"./security" entry', () => {
    it('exposes the constant-time string comparator', () => {
      expect(typeof security.timingSafeEqualStrings).toBe('function');
    });
  });

  describe('"./extensions" entry', () => {
    it('exposes the extension registry primitives', () => {
      expect(typeof extensions.getExtension).toBe('function');
      expect(typeof extensions.setExtension).toBe('function');
      expect(extensions.EXTENSION_REGISTRY).toBeInstanceOf(Map);
    });

    it('exposes the payment-identifier extension surface', () => {
      expect(extensions.EXTENSION_PAYMENT_IDENTIFIER).toBe('payment-identifier');
      expect(typeof extensions.PAYMENT_ID_DEFAULT_PREFIX).toBe('string');
      expect(typeof extensions.PAYMENT_ID_MAX_LENGTH).toBe('number');
      expect(typeof extensions.PAYMENT_ID_MIN_LENGTH).toBe('number');
      expect(extensions.PAYMENT_ID_REGEX).toBeInstanceOf(RegExp);
      expect(typeof extensions.PAYMENT_IDENTIFIER).toBe('object');
      expect(typeof extensions.generatePaymentId).toBe('function');
      expect(typeof extensions.validatePaymentId).toBe('function');
    });
  });

  describe('"./extras" entry', () => {
    it('exposes the extra-map accessors', () => {
      expect(typeof extras.getExtra).toBe('function');
      expect(typeof extras.setExtra).toBe('function');
    });
  });
});
