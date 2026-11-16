import { describe, expect, it } from 'vitest';

import { decode, encode, readMppPaymentAmount } from '../../src/index.js';

describe('readMppPaymentAmount', () => {
  it.each(['card', 'stripe'])('interprets %s USD cents exactly without mutating the request', (method) => {
    for (const [amount, expected] of [
      ['0', '0.00'],
      ['1', '0.01'],
      ['50', '0.50'],
      ['100', '1.00'],
      ['125', '1.25'],
      ['00100', '1.00'],
      ['99999999', '999999.99'],
      ['900719925474099301', '9007199254740993.01'],
    ]) {
      const request = Object.freeze({ amount, currency: 'usd' });
      const encoded = encode(request);
      expect(readMppPaymentAmount(method, decode(encoded))).toEqual({ amount: expected, currency: 'USD' });
      expect(encode(request)).toBe(encoded);
    }
  });

  it.each([undefined, null, 100, '', '-100', '1.5', '1e2', ' 100', '100\n', 'Infinity'])(
    'does not present invalid USD minor units %j as dollars',
    (amount) => {
      expect(readMppPaymentAmount('card', { amount, currency: 'usd' })).toEqual({ currency: 'USD' });
    },
  );

  it.each([undefined, null, [], '100', 100, true])('ignores non-object request %j', (request) => {
    expect(readMppPaymentAmount('card', request)).toEqual({});
  });

  it.each([
    ['inflow', { amount: '0.01', currency: 'USDC' }],
    ['inflow', { amount: '1.00', currency: 'USD' }],
    ['tempo', { amount: '10000', currency: '0xAbCd' }],
    ['custom', { amount: '100', currency: 'usd' }],
    ['card', { amount: '100', currency: 'jpy' }],
    ['stripe', { amount: '100', currency: 'eur' }],
  ] as const)('preserves units not interpreted for %s: %j', (method, request) => {
    expect(readMppPaymentAmount(method, request)).toEqual(request);
  });

  it.each([
    [{}, {}],
    [{ amount: '1' }, { amount: '1' }],
    [{ currency: 'USD' }, { currency: 'USD' }],
    [{ amount: 1, currency: [] }, {}],
  ])('omits missing or non-string fields: %j', (request, expected) => {
    expect(readMppPaymentAmount('inflow', request)).toEqual(expected);
  });
});
