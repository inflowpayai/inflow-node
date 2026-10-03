import { Method, z } from 'mppx';

const publicEncryptionKey = z.object({
  kty: z.literal('RSA'),
  alg: z.literal('RSA-OAEP-256'),
  use: z.literal('enc'),
  kid: z.string().check(z.minLength(1)),
  n: z.string().check(z.regex(/^[A-Za-z0-9_-]+$/)),
  e: z.string().check(z.regex(/^[A-Za-z0-9_-]+$/)),
});

/** InFlow's USD/Visa profile; wire amounts are integer cents, not dollars. */
export const cardChargeRequestSchema = z.object({
  amount: z.string().check(
    z.regex(/^[1-9]\d{0,7}$/),
    z.refine((value) => Number(value) >= 50, 'Minimum is 50 cents'),
  ),
  currency: z.literal('usd'),
  recipient: z.string().check(z.minLength(1), z.maxLength(255)),
  description: z.optional(z.string()),
  externalId: z.optional(z.string().check(z.maxLength(255))),
  methodDetails: z.object({
    acceptedNetworks: z.array(z.literal('visa')).check(z.minLength(1)),
    merchantName: z.string().check(z.minLength(1), z.maxLength(255)),
    encryptionJwk: publicEncryptionKey,
    billingRequired: z.optional(z.boolean()),
  }),
});

/** The encrypted payload stays opaque; InFlow decrypts and verifies it. */
export const cardCredentialPayloadSchema = z.looseObject({
  encryptedPayload: z.string().check(z.minLength(1), z.maxLength(16_384)),
  network: z.literal('visa'),
  panLastFour: z.string().check(z.regex(/^\d{4}$/)),
  panExpirationMonth: z.string().check(z.regex(/^(?:0[1-9]|1[0-2])$/)),
  panExpirationYear: z.string().check(z.regex(/^\d{4}$/)),
  billingAddress: z.optional(
    z.looseObject({
      line1: z.optional(z.string()),
      line2: z.optional(z.string()),
      city: z.optional(z.string()),
      state: z.optional(z.string()),
      zip: z.optional(z.string()),
      countryCode: z.optional(z.string()),
    }),
  ),
  cardholderFullName: z.optional(z.string()),
  paymentAccountReference: z.optional(z.string()),
});

export type CardChargeRequest = z.infer<typeof cardChargeRequestSchema>;
export type CardCredentialPayload = z.infer<typeof cardCredentialPayloadSchema>;

export const cardCharge = Method.from({
  name: 'card',
  intent: 'charge',
  schema: { request: cardChargeRequestSchema, credential: { payload: cardCredentialPayloadSchema } },
});
