import { describe, expect, it } from 'vitest';

import { accepts, cardControls, inflowControls, tempoControls } from '../../src/controls.js';

const currency = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const auth = { apiKey: 'synthetic' };
const request = { amount: '1500000', currency, recipient, methodDetails: { chainId: 4217 } };

describe('method-specific controls', () => {
  it('does not impose default limits', () => {
    inflowControls(auth)({ amount: '99999999999999999999', currency: 'USD' });
    cardControls(auth)({ amount: '99999999' });
    tempoControls(auth)({ amount: '999999999999999999999999' });
  });

  it('compares decimal currency values without floating-point rounding', () => {
    const check = inflowControls({ ...auth, currencies: ['USDC'], maxAmount: '9007199254740993.000000000000000001' });
    check({ amount: '9007199254740993.0000000000000000010', currency: 'USDC' });
    expect(() => check({ amount: '9007199254740993.000000000000000002', currency: 'USDC' })).toThrow('maxAmount');
    expect(() => check({ amount: '1', currency: 'USD' })).toThrow('currency');
  });

  it('compares integer limits and fractional charges in the same currency units', () => {
    const check = inflowControls({ ...auth, currencies: ['USD'], maxAmount: '2' });
    check({ amount: '2', currency: 'USD' });
    check({ amount: '1.99', currency: 'USD' });
    expect(() => check({ amount: '2.01', currency: 'USD' })).toThrow('maxAmount');
    const fractional = inflowControls({ ...auth, currencies: ['USD'], maxAmount: '2.50' });
    fractional({ amount: '2', currency: 'USD' });
    expect(() => fractional({ amount: '3', currency: 'USD' })).toThrow('maxAmount');
  });

  it('pins InFlow recipients and snapshots caller-owned lists', () => {
    const currencies = ['USD'];
    const recipients = ['seller'];
    const check = inflowControls({ ...auth, currencies, expectedRecipients: recipients });
    currencies.push('EUR');
    recipients.push('other');
    check({ amount: '1', currency: 'USD', recipient: 'seller' });
    expect(() => check({ amount: '1', currency: 'EUR', recipient: 'seller' })).toThrow('currency');
    expect(() => check({ amount: '1', currency: 'USD', recipient: 'other' })).toThrow('recipient');
    expect(() => check({ amount: '1', currency: 'USD' })).toThrow('recipient');
    expect(() => inflowControls({ ...auth, currencies: [] })({ amount: '0', currency: 'USD' })).toThrow('currency');
  });

  it.each(['-1', '1e3', 'NaN', '', '1.'])('rejects malformed limits at construction: %s', (maxAmount) => {
    expect(() => inflowControls({ ...auth, currencies: ['USD'], maxAmount })).toThrow();
    expect(() => cardControls({ ...auth, maxAmount })).toThrow();
    expect(() => tempoControls({ ...auth, currencies: [], maxAmount })).toThrow();
  });

  it('requires currency selection and exact precision', () => {
    expect(() => inflowControls({ ...auth, maxAmount: '1' })).toThrow('currencies');
    expect(() => tempoControls({ ...auth, maxAmount: '1' })).toThrow('currencies');
    expect(() => tempoControls({ ...auth, maxAtomicAmount: '1' })).toThrow('currencies');
    expect(() => tempoControls({ ...auth, currencies: [currency], maxAmount: '1' })).toThrow('decimals');
    expect(() => tempoControls({ ...auth, currencies: [currency], decimals: 2, maxAmount: '1.001' })).toThrow(
      'precision',
    );
    expect(() => cardControls({ ...auth, maxAmount: '1.001' })).toThrow('precision');
    expect(() => cardControls({ ...auth, maxAtomicAmount: '1.1' })).toThrow('integer');
    expect(() => tempoControls({ ...auth, maxAtomicAmount: '-1' })).toThrow('integer');
  });

  it('treats CARD display limits as dollars and atomic limits as cents', () => {
    const check = cardControls({ ...auth, maxAmount: '1.500', maxAtomicAmount: '140' });
    check({ amount: '140' });
    expect(() => check({ amount: '141' })).toThrow();
    expect(() => check({ amount: '151' })).toThrow();
  });

  it('checks Tempo amount, chain, currency and every recipient', () => {
    const check = tempoControls({
      ...auth,
      currencies: [currency],
      decimals: 6,
      maxAmount: '1.5',
      maxAtomicAmount: '1500000',
      allowedChainIds: [4217],
      expectedRecipients: [recipient],
    });
    check(request);
    check({ ...request, methodDetails: { chainId: 4217, splits: [{ recipient }] } });
    expect(() => check({ ...request, amount: '1500001' })).toThrow();
    expect(() => check({ ...request, currency: other })).toThrow('currency');
    expect(() => check({ ...request, currency: undefined })).toThrow('currency');
    expect(() => check({ ...request, methodDetails: undefined })).toThrow('chain');
    expect(() => check({ ...request, methodDetails: { chainId: 1 } })).toThrow('chain');
    expect(() => check({ ...request, recipient: undefined })).toThrow('recipient');
    expect(() => check({ ...request, methodDetails: { chainId: 4217, splits: [{ recipient: other }] } })).toThrow(
      'recipient',
    );
    expect(() => tempoControls({ ...auth, allowedChainIds: [] })(request)).toThrow('chain');
    expect(() => tempoControls({ ...auth, currencies: [] })(request)).toThrow('currency');
    expect(() => tempoControls({ ...auth, expectedRecipients: [] })(request)).toThrow('recipient');
  });

  it('uses native chain-bound currency metadata for display-unit limits', () => {
    const check = tempoControls({
      ...auth,
      currencies: [{ address: currency, chainId: 4217, decimals: 6 }],
      maxAmount: '1.5',
    });
    check(request);
    expect(() => check({ ...request, amount: '1500001' })).toThrow();
    expect(() => check({ ...request, methodDetails: { chainId: 1 } })).toThrow('currency');
    expect(() => check({ ...request, methodDetails: undefined })).toThrow('currency');
  });

  it.each([-1, 1.5, Infinity, 256])('rejects unusable decimals %s', (decimals) => {
    expect(() => tempoControls({ ...auth, decimals })).toThrow('decimals');
  });

  it.each([-1, 1.5, Infinity])('rejects unusable chain IDs %s', (chainId) => {
    expect(() => tempoControls({ ...auth, allowedChainIds: [chainId] })).toThrow('chain');
  });

  it('selection rejects violations without throwing', () => {
    expect(accepts(() => cardControls({ ...auth, maxAmount: '1' })({ amount: '100' }))).toBe(true);
    expect(accepts(() => cardControls({ ...auth, maxAmount: '1' })({ amount: '101' }))).toBe(false);
  });
});
