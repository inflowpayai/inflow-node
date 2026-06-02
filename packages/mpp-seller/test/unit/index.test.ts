import { describe, expect, it } from 'vitest';

import * as pkg from '../../src/index.js';

describe('public barrel', () => {
  it('re-exports the inflow factory, config client, errors, and the foundation Mppx + Receipt', () => {
    expect(typeof pkg.inflow).toBe('function');
    expect(typeof pkg.createConfigClient).toBe('function');
    expect(typeof pkg.MppRedeemProblemError).toBe('function');
    expect(typeof pkg.MppUnsupportedCurrencyError).toBe('function');
    // Foundation re-exports: a single import gives both the server handler and receipt helpers.
    expect(typeof pkg.Mppx.create).toBe('function');
    expect(typeof pkg.Receipt.from).toBe('function');
    expect(typeof pkg.Expires.seconds).toBe('function');
  });

  it('does not export body-digest helpers', () => {
    expect('computeBodyDigest' in pkg).toBe(false);
    expect('verifyBodyDigest' in pkg).toBe(false);
  });
});
