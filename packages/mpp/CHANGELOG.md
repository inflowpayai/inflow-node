# @inflowpayai/mpp

## 0.8.0

### Minor Changes

- [#42](https://github.com/inflowpayai/inflow-node/pull/42)
  [`fd4727f`](https://github.com/inflowpayai/inflow-node/commit/fd4727f3771fa9fef4617bca3be03b3cf3447d9e) Thanks
  [@nkavian](https://github.com/nkavian)! - Advertise settlement rails by intent and currency, require an explicit rail
  when the available choice is ambiguous, and validate InFlow subscription terms against the server contract.
  Subscription seller helpers accept multiple plans in one currency, subscription receipts preserve the server-issued
  identifier and seller reconciliation metadata, and clients can derive stable option fingerprints without volatile
  challenge or expiration fields.

### Patch Changes

- [#35](https://github.com/inflowpayai/inflow-node/pull/35)
  [`ec39b71`](https://github.com/inflowpayai/inflow-node/commit/ec39b711d355026c6d4c71d8cc472f83e78b0ba3) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Align MPP problem handling and receipt parsing with the current
  protocol while preserving existing wire behavior.

  - Parse and expose optional `hint` and `details` on `MppProblemDetail`.
  - Sanitise `extensions` so it cannot override canonical RFC 9457 fields, top-level `hint`/`details`, or challenge
    identifiers.
  - Preserve forward-compatible, method-specific top-level receipt fields from `/v1/mpp/redeem` responses when
    translating to mppx receipts, including the InFlow server's optional external and subscription identifiers.

- [#34](https://github.com/inflowpayai/inflow-node/pull/34)
  [`0d70feb`](https://github.com/inflowpayai/inflow-node/commit/0d70feb8c1543c88a5095f17aed33f565ea6a1a3) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Require mppx 0.8.17 for current discovery and composed-offer
  behavior.

  Expose request-aware `canOffer` hooks on the InFlow and Tempo seller method constructors.

  Re-export discovery helpers so buyers can normalize legacy metadata and sellers can emit canonical
  `x-payment-info.offers[]` documents. Document server-wide `selectOffers` policy alongside method-level gating.

- [#37](https://github.com/inflowpayai/inflow-node/pull/37)
  [`06a6eaa`](https://github.com/inflowpayai/inflow-node/commit/06a6eaa338fae4e8a321677e682077cf06409b53) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Reject missing or empty MPP challenge identifiers at both parsing
  and rendering boundaries.

## 0.7.1

### Patch Changes

- [#31](https://github.com/inflowpayai/inflow-node/pull/31)
  [`fcf912e`](https://github.com/inflowpayai/inflow-node/commit/fcf912e9163db0779186684a86326df025bd414e) Thanks
  [@nkavian](https://github.com/nkavian)! - Require mppx 0.8.12 or newer and emit MPP receipts with `challengeId` and
  nested `settlement.amount` and `settlement.currency` fields.

- [#31](https://github.com/inflowpayai/inflow-node/pull/31)
  [`56f6c8b`](https://github.com/inflowpayai/inflow-node/commit/56f6c8b9e9ad169f6bc3ee45d387dc4575946682) Thanks
  [@nkavian](https://github.com/nkavian)! - Validate credential structure during decoding, accept core MPP receipts
  while preserving method-specific extensions, and reject empty required fields and duplicate parameters when parsing
  payment challenges.

## 0.7.0

### Minor Changes

- [#29](https://github.com/inflowpayai/inflow-node/pull/29)
  [`a81e266`](https://github.com/inflowpayai/inflow-node/commit/a81e266b523b082ddbde9b252ad4f536229e5c27) Thanks
  [@nkavian](https://github.com/nkavian)! - Preserve the challenge `opaque` blob through parse, render, and the echoed
  credential `challenge` so a seller can recompute its HMAC challenge binding, and add optional `amount`/`currency`
  settlement fields to `MppReceipt` for reconciliation.

### Patch Changes

- [#27](https://github.com/inflowpayai/inflow-node/pull/27)
  [`9b9ac40`](https://github.com/inflowpayai/inflow-node/commit/9b9ac40afb6ed778bf4d9bfc851312fb49d9812a) Thanks
  [@nkavian](https://github.com/nkavian)! - Tighten static analysis settings and clean up newly enforced TypeScript and
  ESLint diagnostics.

## 0.6.0

### Minor Changes

- [#24](https://github.com/inflowpayai/inflow-node/pull/24)
  [`177e4c4`](https://github.com/inflowpayai/inflow-node/commit/177e4c4962613c43d111289fe8a8a28eaf068053) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Add the Tempo MPP method end to end: the shared request/credential
  schemas and types in `@inflowpayai/mpp`, seller-side challenge minting in `@inflowpayai/mpp-seller`, and buyer-side
  fulfilment in `@inflowpayai/mpp-buyer`. Tempo settles on-chain via pull-mode credentials minted by the InFlow PSP;
  fee-payer sponsorship is opt-in via `methodDetails.feePayer` and defaults to off.

## 0.5.1

### Patch Changes

- [#19](https://github.com/inflowpayai/inflow-node/pull/19)
  [`9c18441`](https://github.com/inflowpayai/inflow-node/commit/9c18441acc9f69873c6a94690bb12d6672db5de5) Thanks
  [@nkavian](https://github.com/nkavian)! - Source the challenge `recipient` from the authenticated seller.
  `GET /v1/mpp/config` now returns the seller's `sellerId`, and the seller `inflow` method stamps it as the `recipient`
  on every minted challenge. Adds `sellerId` to the `MppConfigResponse` type (`@inflowpayai/mpp`) and removes the
  `recipient` option from `InflowSellerParameters` (`@inflowpayai/mpp-seller`) — the recipient is no longer
  caller-supplied. Fixes the server rejecting fulfilment with `invalid-challenge: "Recipient or sender is missing."`

- [#19](https://github.com/inflowpayai/inflow-node/pull/19)
  [`9c18441`](https://github.com/inflowpayai/inflow-node/commit/9c18441acc9f69873c6a94690bb12d6672db5de5) Thanks
  [@nkavian](https://github.com/nkavian)! - Remove the MPP protocol/SDK version gate. The server's `GET /v1/mpp/config`
  response no longer carries `protocolVersion` or `minSdkVersion`, so the SDK no longer reads or enforces them. Removed
  from `@inflowpayai/mpp`: the `MPP_PROTOCOL_VERSION` and `MPP_SDK_VERSION` constants, the `MppProtocolVersionError`
  error class, and the `protocolVersion`/`minSdkVersion` fields on the `MppConfigResponse` type.
  `@inflowpayai/mpp-seller` no longer re-exports `MppProtocolVersionError`, and `createConfigClient` no longer
  version-gates on load.

## 0.5.0

### Minor Changes

- Initial release: the shared MPP definitions for InFlow's `inflow` payment method — the `inflow` `Method` namespace
  (defaulting to `charge`), the MPP wire types, the RFC 8785 JCS + base64url codec and `WWW-Authenticate: Payment`
  header render/parse, the InFlow MPP REST client, protocol constants, and typed errors.
