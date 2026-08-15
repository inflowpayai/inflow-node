import { Method, z } from 'mppx';

import {
  CREDENTIAL_TRANSACTION_ID,
  INTENT_CHARGE,
  INTENT_SUBSCRIPTION,
  METHOD_INFLOW,
  METHOD_TEMPO,
} from './constants.js';

// The shared MPP Method definitions (`inflow`, `tempo`). The foundation SDK (mppx) mints + HMAC-binds challenges
// locally with the seller's secret; InFlow is the PSP that issues and settles credentials via its REST endpoints and
// does not verify the challenge HMAC. These definitions carry only the schemas (the shared contract); the
// client/server behaviour (`Method.toClient` / `Method.toServer`) is attached in `@inflowpayai/mpp-buyer` and
// `@inflowpayai/mpp-seller`, which forward to the InFlow REST endpoints rather than signing/verifying locally.
//
// Each method is organised as a Method namespace: the `inflow` / `tempo` exports default to `charge`, so consumers
// write `inflow(...)` or `inflow.charge(...)` (and likewise `tempo`), leaving room for sibling intents (see
// docs/mpp/extensions.md) to attach without changing the import surface.

/**
 * Decimal-string amount validator. Amounts are carried as plain decimal strings on the wire (the server serialises
 * `BigDecimal` via `toPlainString`), never as JS `number` — parsing through `Number()` would lose precision and break
 * the HMAC binding. This accepts an optionally-signed, non-exponential decimal and rejects anything else.
 */
// `mppx` re-exports zod's tree-shakeable "mini" build, so checks are applied via `.check(z.regex(...))` and modifiers
// are wrappers (`z.optional(...)`) rather than the chainable methods of classic zod.
const decimalString = z.string().check(z.regex(/^-?\d+(\.\d+)?$/));

const positiveDecimalString = z.string().check(
  z.regex(/^\d+(\.\d+)?$/),
  z.refine((value) => /[1-9]/.test(value), 'Amount must be positive'),
);

const bytes32Hex = z.string().check(z.regex(/^0x[0-9a-fA-F]{64}$/));

const hexAddress = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));

const hexString = z.string().check(z.regex(/^0x[0-9a-fA-F]+$/));

const integerString = z.string().check(z.regex(/^(0|[1-9]\d*)$/));

const nonEmptyString = z.string().check(z.minLength(1));

const subscriptionExternalId = z.string().check(
  z.minLength(1),
  z.maxLength(128),
  z.refine((value) => value.trim().length > 0, 'externalId must not be blank'),
);

const subscriptionPeriodCount = z
  .number()
  .check(z.refine((value) => Number.isSafeInteger(value) && value > 0, 'periodCount must be a positive safe integer'));

// Rails wire as the `MppRail` lowercase `@JsonValue` label (consistent with `method`/`intent`). The server's
// `@JsonCreator` also accepts the uppercase enum name on input. The `inflow` method serves two rails: `balance`
// (crypto) and `instrument` (fiat).
const railLabel = z.enum(['balance', 'instrument']);

const tempoSubmissionMode = z.enum(['pull', 'push']);

const tempoSplitSchema = z.object({
  amount: integerString,
  recipient: hexAddress,
  memo: z.optional(bytes32Hex),
});

const tempoMethodDetailsSchema = z.optional(
  z.object({
    chainId: z.optional(z.number()),
    feePayer: z.optional(z.boolean()),
    memo: z.optional(bytes32Hex),
    splits: z.optional(z.array(tempoSplitSchema)),
    supportedModes: z.optional(z.array(tempoSubmissionMode)),
  }),
);

/**
 * Schema for the `inflow` charge request's `methodDetails` selector object. `rail` is derived by the seller SDK from
 * the charge currency (crypto → `balance`, fiat → `instrument`) via the config `currencyRails` capability; it is
 * carried here and bound. Optional so a balance charge may omit it and let the rail default downstream. `instrumentId`
 * is only meaningful for `rail: 'instrument'`.
 */
const inflowMethodDetailsSchema = z.optional(
  z.object({
    rail: z.optional(railLabel),
    instrumentId: z.optional(z.guid()),
  }),
);

/**
 * Schema for the `inflow` charge request — the method-specific object carried (base64url-JCS) in
 * `MppChallenge.request`. Byte-compatible with the server's `InflowChallengeRequest`: the rail/instrument selectors are
 * nested under `methodDetails`, and `amount` is a decimal string. `recipient` maps to the server's `recipientId`
 * (`@JsonProperty("recipient")`). The nested `methodDetails` JCS-encodes deterministically (sorted keys), so byte
 * parity with the server's DTO holds.
 */
export const inflowChargeRequestSchema = z.object({
  amount: decimalString,
  currency: nonEmptyString,
  // `z.guid()` (lenient 8-4-4-4-12 hex), not `z.uuid()`: InFlow recipient ids are generic Java UUIDs and the strict
  // RFC 9562 variant/version check would reject otherwise-valid server-issued ids.
  recipient: z.optional(z.guid()),
  methodDetails: inflowMethodDetailsSchema,
});

/** Recurring period unit for a subscription challenge — mirrors the server's `SubscriptionPeriod` `@JsonValue` labels. */
const subscriptionPeriodLabel = z.enum(['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']);

/**
 * Schema for the `inflow` subscription request — the `charge` request plus the recurring terms. Byte-compatible with
 * the server's `InflowChallengeRequest` when the enclosing challenge's `intent` is `subscription`: `periodUnit` is the
 * `SubscriptionPeriod` label, `periodCount` a positive integer, `subscriptionExpires` an RFC 3339 timestamp, and
 * `externalId` optional seller reconciliation metadata that is not used for lookup or authorization. The four
 * subscription fields are top-level siblings of `amount`/`currency`/`methodDetails`, and (being NON_NULL on the server)
 * JCS-encode in sorted-key order for byte parity.
 */
export const inflowSubscriptionRequestSchema = z
  .object({
    amount: positiveDecimalString,
    currency: nonEmptyString,
    recipient: z.optional(z.guid()),
    methodDetails: inflowMethodDetailsSchema,
    periodUnit: subscriptionPeriodLabel,
    periodCount: subscriptionPeriodCount,
    subscriptionExpires: z.datetime(),
    externalId: z.optional(subscriptionExternalId),
  })
  .check(
    z.refine(({ periodCount, periodUnit }) => periodUnit !== 'minute' || periodCount >= 5, {
      message: 'periodCount must be at least 5 for minute.',
      path: ['periodCount'],
    }),
  );

/**
 * Schema for the `inflow` credential proof payload (`MppCredential.payload`). The proof is rail-specific and produced
 * server-side — `balance` or `instrument` only (no blockchain `transactionHash`) — so the shape is an open record
 * rather than a fixed object. The server also stamps the server-minted correlation key `'transactionId'` (exported as
 * `CREDENTIAL_TRANSACTION_ID`) into this payload at initiate; the seller forwards the credential to `/redeem`, where
 * the server reads it back to correlate and settle. It survives encode/decode unchanged as part of the open record.
 */
export const inflowCredentialPayloadSchema = z.record(z.string(), z.unknown());

/**
 * Schema for the `tempo` charge request — the method-specific object carried (base64url-JCS) in `MppChallenge.request`.
 * Byte-compatible with the server's `TempoChallengeRequest`: `amount` is a base-unit integer string, `currency` is the
 * TIP-20 token address, `recipient` is a Tempo address, and the on-chain selectors (chain id, fee-payer, memo, splits,
 * supported modes) are nested under `methodDetails`.
 */
export const tempoChargeRequestSchema = z.object({
  amount: integerString,
  currency: z.optional(hexAddress),
  recipient: z.optional(hexAddress),
  description: z.optional(nonEmptyString),
  externalId: z.optional(nonEmptyString),
  methodDetails: tempoMethodDetailsSchema,
});

/**
 * Schema for the `tempo` credential payload. Pull mode carries a signed Tempo transaction in `signature`; push mode
 * carries `hash`; zero-amount proof credentials also carry `signature`.
 */
export const tempoCredentialPayloadSchema = z.object({
  type: z.enum(['transaction', 'hash', 'proof']),
  hash: z.optional(hexString),
  signature: z.optional(hexString),
  [CREDENTIAL_TRANSACTION_ID]: z.optional(nonEmptyString),
});

/** Inferred type of a validated {@link inflowChargeRequestSchema} value. */
export type InflowChargeRequestInput = z.infer<typeof inflowChargeRequestSchema>;

/** Inferred type of a validated {@link inflowSubscriptionRequestSchema} value. */
export type InflowSubscriptionRequestInput = z.infer<typeof inflowSubscriptionRequestSchema>;

/** Inferred type of a validated {@link inflowCredentialPayloadSchema} value. */
export type InflowCredentialPayloadInput = z.infer<typeof inflowCredentialPayloadSchema>;

/** Inferred type of a validated {@link tempoChargeRequestSchema} value. */
export type TempoChargeRequestInput = z.infer<typeof tempoChargeRequestSchema>;

/** Inferred type of a validated {@link tempoCredentialPayloadSchema} value. */
export type TempoCredentialPayloadInput = z.infer<typeof tempoCredentialPayloadSchema>;

/**
 * The `inflow` charge Method definition. The shared (schema-only) half of the custom method; buyer/seller packages
 * attach `toClient`/`toServer` to it.
 */
export const charge = Method.from({
  intent: INTENT_CHARGE,
  name: METHOD_INFLOW,
  schema: {
    request: inflowChargeRequestSchema,
    credential: {
      payload: inflowCredentialPayloadSchema,
    },
  },
});

/**
 * The `inflow` subscription Method definition — a sibling intent on the `inflow` method (see docs/mpp/extensions.md).
 * Shares the `inflow` credential payload; differs only in its request schema (the recurring terms).
 */
export const subscription = Method.from({
  intent: INTENT_SUBSCRIPTION,
  name: METHOD_INFLOW,
  schema: {
    request: inflowSubscriptionRequestSchema,
    credential: {
      payload: inflowCredentialPayloadSchema,
    },
  },
});

/** The `tempo` charge Method definition. */
export const tempoCharge = Method.from({
  intent: INTENT_CHARGE,
  name: METHOD_TEMPO,
  schema: {
    request: tempoChargeRequestSchema,
    credential: {
      payload: tempoCredentialPayloadSchema,
    },
  },
});

/**
 * The `inflow` Method namespace. Defaults to {@link charge} and exposes it as `inflow.charge`, leaving room for a
 * sibling `inflow.session` to be added later without changing the import surface (see docs/mpp/extensions.md).
 */
export const inflow: typeof charge & { readonly charge: typeof charge; readonly subscription: typeof subscription } =
  Object.assign(charge, { charge, subscription });

/** The `tempo` Method namespace. Defaults to {@link tempoCharge} and exposes it as `tempo.charge`. */
export const tempo: typeof tempoCharge & { readonly charge: typeof tempoCharge } = Object.assign(tempoCharge, {
  charge: tempoCharge,
});
