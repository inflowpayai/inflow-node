import { Method, z } from 'mppx';

import { INTENT_CHARGE, METHOD_INFLOW } from './constants.js';

// The shared `inflow` Method definition. The foundation SDK (mppx) mints + HMAC-binds challenges locally with the
// seller's secret; InFlow is the PSP that issues and settles credentials via its REST endpoints and does not verify
// the challenge HMAC. This definition carries only the schemas (the shared contract); the client/server
// behaviour (`Method.toClient` / `Method.toServer`) is attached in `@inflowpayai/mpp-buyer` and `@inflowpayai/mpp-seller`,
// which forward to the InFlow REST endpoints rather than signing/verifying locally.
//
// Organised as a Method namespace: the `inflow` export defaults to `charge`, so consumers write `inflow(...)` or
// `inflow.charge(...)`, and a sibling such as `inflow.session` (see docs/mpp/extensions.md) attaches without changing
// the import surface.

/**
 * Decimal-string amount validator. Amounts are carried as plain decimal strings on the wire (the server serialises
 * `BigDecimal` via `toPlainString`), never as JS `number` — parsing through `Number()` would lose precision and break
 * the HMAC binding. This accepts an optionally-signed, non-exponential decimal and rejects anything else.
 */
// `mppx` re-exports zod's tree-shakeable "mini" build, so checks are applied via `.check(z.regex(...))` and modifiers
// are wrappers (`z.optional(...)`) rather than the chainable methods of classic zod.
const decimalString = z.string().check(z.regex(/^-?\d+(\.\d+)?$/));

const nonEmptyString = z.string().check(z.minLength(1));

// Rails wire as the `MppRail` lowercase `@JsonValue` label (consistent with `method`/`intent`). The server's
// `@JsonCreator` also accepts the uppercase enum name on input. The `inflow` method serves two rails: `balance`
// (crypto) and `instrument` (fiat).
const railLabel = z.enum(['balance', 'instrument']);

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

/**
 * Schema for the `inflow` credential proof payload (`MppCredential.payload`). The proof is rail-specific and produced
 * server-side — `balance` or `instrument` only (no blockchain `transactionHash`) — so the shape is an open record
 * rather than a fixed object. The server also stamps the server-minted correlation key `'transactionId'` (exported as
 * `CREDENTIAL_TRANSACTION_ID`) into this payload at initiate; the seller forwards the credential to `/redeem`, where
 * the server reads it back to correlate and settle. It survives encode/decode unchanged as part of the open record.
 */
export const inflowCredentialPayloadSchema = z.record(z.string(), z.unknown());

/** Inferred type of a validated {@link inflowChargeRequestSchema} value. */
export type InflowChargeRequestInput = z.infer<typeof inflowChargeRequestSchema>;

/** Inferred type of a validated {@link inflowCredentialPayloadSchema} value. */
export type InflowCredentialPayloadInput = z.infer<typeof inflowCredentialPayloadSchema>;

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
 * The `inflow` Method namespace. Defaults to {@link charge} and exposes it as `inflow.charge`, leaving room for a
 * sibling `inflow.session` to be added later without changing the import surface (see docs/mpp/extensions.md).
 */
export const inflow: typeof charge & { readonly charge: typeof charge } = Object.assign(charge, { charge });
