import { describe, expect, it } from 'vitest';

import { cardCharge, cardChargeRequestSchema, cardCredentialPayloadSchema } from '../../src/index.js';

const request = {
  amount: '100',
  currency: 'usd',
  recipient: 'acct_seller',
  methodDetails: {
    acceptedNetworks: ['visa'],
    merchantName: 'Test Seller',
    encryptionJwk: { kty: 'RSA', alg: 'RSA-OAEP-256', use: 'enc', kid: 'key-1', n: 'public-modulus', e: 'AQAB' },
  },
};
const payload = {
  encryptedPayload: 'opaque-encrypted-credential',
  network: 'visa',
  panLastFour: '4242',
  panExpirationMonth: '06',
  panExpirationYear: '2028',
};

describe('InFlow CARD wire profile', () => {
  it('defines card/charge and accepts exact cents at both limits', () => {
    expect(cardCharge.name).toBe('card');
    expect(cardCharge.intent).toBe('charge');
    for (const amount of ['50', '100', '99999999']) {
      expect(cardChargeRequestSchema.parse({ ...request, amount }).amount).toBe(amount);
    }
  });

  it.each(['0', '49', '-100', '1.00', '1e2', '0100', '100000000', 100])('rejects invalid wire amount %s', (amount) => {
    expect(cardChargeRequestSchema.safeParse({ ...request, amount }).success).toBe(false);
  });

  it('keeps only public encryption fields and no duplicate expiry', () => {
    const parsed = cardChargeRequestSchema.parse({
      ...request,
      expires: '2099-01-01T00:00:00Z',
      methodDetails: {
        ...request.methodDetails,
        encryptionJwk: { ...request.methodDetails.encryptionJwk, d: 'private-key' },
      },
    });
    expect(parsed).toEqual(request);
  });

  it.each([
    { currency: 'eur' },
    { recipient: '' },
    { externalId: 'x'.repeat(256) },
    { methodDetails: { ...request.methodDetails, acceptedNetworks: [] } },
    { methodDetails: { ...request.methodDetails, acceptedNetworks: ['mastercard'] } },
    { methodDetails: { ...request.methodDetails, encryptionJwk: undefined } },
  ])('rejects an unsupported request %j', (fields) => {
    expect(cardChargeRequestSchema.safeParse({ ...request, ...fields }).success).toBe(false);
  });

  it('preserves credential extensions and billing data without parsing encrypted content', () => {
    const complete = {
      ...payload,
      billingAddress: { line1: '10 Market St', zip: '94102', countryCode: 'US', extension: 'unchanged' },
      cardholderFullName: 'Test Buyer',
      paymentAccountReference: 'test-par',
      transactionId: 'optional-inflow-reference',
    };
    expect(cardCredentialPayloadSchema.parse(complete)).toEqual(complete);
  });

  it.each([
    { encryptedPayload: '' },
    { encryptedPayload: 'x'.repeat(16_385) },
    { network: 'mastercard' },
    { panLastFour: '42' },
    { panExpirationMonth: '00' },
    { panExpirationMonth: '13' },
    { panExpirationYear: '28' },
    { billingAddress: { zip: 94102 } },
  ])('rejects malformed credential metadata %j', (fields) => {
    expect(cardCredentialPayloadSchema.safeParse({ ...payload, ...fields }).success).toBe(false);
  });
});
