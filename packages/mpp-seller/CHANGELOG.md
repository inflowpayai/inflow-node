# @inflowpayai/mpp-seller

## 0.10.0

### Minor Changes

- [#100](https://github.com/inflowpayai/inflow-node/pull/100)
  [`dfc2a2f`](https://github.com/inflowpayai/inflow-node/commit/dfc2a2f17be78d8b16c4e477d61110bf7cbeff4e) Thanks
  [@nkavian](https://github.com/nkavian)! - Classify malformed platform responses as internal errors rather than payment
  rejections. Add paymentHttpTransport for JSON server-error responses without a fresh payment challenge.

## 0.9.0

### Minor Changes

- [#64](https://github.com/inflowpayai/inflow-node/pull/64)
  [`9886e0e`](https://github.com/inflowpayai/inflow-node/commit/9886e0ea655d9d8da0251f376e4cf7280704ac02) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Add an async Stripe charge method that uses the official mppx wire
  schema, loads the authenticated seller profile from InFlow, validates exact USD limits before challenge issuance,
  binds credential references to seller-provided references, and delegates validation and settlement to the PSP.
  Document the Stripe Connect setup required for sellers.

- [#95](https://github.com/inflowpayai/inflow-node/pull/95)
  [`6a8ec32`](https://github.com/inflowpayai/inflow-node/commit/6a8ec328ef7410b306518488c9276a003eaac9fd) Thanks
  [@nkavian](https://github.com/nkavian)! - Add CARD seller acceptance for USD Visa network-token payments. Load
  merchant and public encryption details from InFlow, construct bound challenges through mppx, and delegate credential
  validation and settlement to InFlow.

### Patch Changes

- [#85](https://github.com/inflowpayai/inflow-node/pull/85)
  [`8eefd36`](https://github.com/inflowpayai/inflow-node/commit/8eefd361edad4200003cf5d7747f725d3331b40c) Thanks
  [@nkavian](https://github.com/nkavian)! - Reject Stripe and InFlow instrument payment receipts that omit the challenge
  identifier or refer to a different payment method or challenge.
- Updated dependencies
  [[`61338d1`](https://github.com/inflowpayai/inflow-node/commit/61338d1cd0a16c6d9bb820cfc2fb58732641194e),
  [`6a8ec32`](https://github.com/inflowpayai/inflow-node/commit/6a8ec328ef7410b306518488c9276a003eaac9fd),
  [`61338d1`](https://github.com/inflowpayai/inflow-node/commit/61338d1cd0a16c6d9bb820cfc2fb58732641194e)]:
  - @inflowpayai/mpp@0.11.0

## 0.8.3

### Patch Changes

- [#80](https://github.com/inflowpayai/inflow-node/pull/80)
  [`684aca5`](https://github.com/inflowpayai/inflow-node/commit/684aca5c80f2bf60b41855fbdede65ef94086f08) Thanks
  [@nkavian](https://github.com/nkavian)! - Allow configuration loading to recover after a failed request, and honor
  subscription offer-selection callbacks with subscription-specific request types.
- Updated dependencies
  [[`354b538`](https://github.com/inflowpayai/inflow-node/commit/354b5387fa967f2837fcf19389e16dc5b521a8bd),
  [`cbf1707`](https://github.com/inflowpayai/inflow-node/commit/cbf17075a6a02ae4aa4d1b655c64bbd69e28eeca),
  [`5d0c59f`](https://github.com/inflowpayai/inflow-node/commit/5d0c59febcc3960d2dd46a2cbf506ce777f1c0c8),
  [`d060d79`](https://github.com/inflowpayai/inflow-node/commit/d060d7996f5443ec659aa1e99b353bcf8388135c)]:
  - @inflowpayai/mpp@0.10.1

## 0.8.2

### Patch Changes

- [#52](https://github.com/inflowpayai/inflow-node/pull/52)
  [`537056b`](https://github.com/inflowpayai/inflow-node/commit/537056b6d0666d81eee55457be3932133d87e224) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Preserve single-use payment credentials while retaining idempotent
  recovery for broadcast transport retries.

## 0.8.1

### Patch Changes

- Updated dependencies
  [[`71d2045`](https://github.com/inflowpayai/inflow-node/commit/71d2045ec6c02d090bad52dce6b3bf14ef133621)]:
  - @inflowpayai/mpp@0.10.0

## 0.8.0

### Minor Changes

- [#45](https://github.com/inflowpayai/inflow-node/pull/45)
  [`2b6f377`](https://github.com/inflowpayai/inflow-node/commit/2b6f377181d45ffb969674460667903f34ce6e17) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Split seller credential handling into non-mutating validation and
  authoritative broadcast, with neutral credential lifecycle request types and typed lifecycle failures.

### Patch Changes

- [#43](https://github.com/inflowpayai/inflow-node/pull/43)
  [`0e5eeb8`](https://github.com/inflowpayai/inflow-node/commit/0e5eeb8ccc1670519a0719dc25d54c7abd8d02bd) Thanks
  [@nkavian](https://github.com/nkavian)! - Document InFlow balance-backed subscriptions with plan fields and complete
  Fetch API, Hono, Express, and Node HTTP integration guidance.
- Updated dependencies
  [[`2b6f377`](https://github.com/inflowpayai/inflow-node/commit/2b6f377181d45ffb969674460667903f34ce6e17)]:
  - @inflowpayai/mpp@0.9.0

## 0.7.0

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

- Updated dependencies
  [[`ec39b71`](https://github.com/inflowpayai/inflow-node/commit/ec39b711d355026c6d4c71d8cc472f83e78b0ba3),
  [`0d70feb`](https://github.com/inflowpayai/inflow-node/commit/0d70feb8c1543c88a5095f17aed33f565ea6a1a3),
  [`06a6eaa`](https://github.com/inflowpayai/inflow-node/commit/06a6eaa338fae4e8a321677e682077cf06409b53),
  [`fd4727f`](https://github.com/inflowpayai/inflow-node/commit/fd4727f3771fa9fef4617bca3be03b3cf3447d9e)]:
  - @inflowpayai/mpp@0.8.0

## 0.6.2

### Patch Changes

- [#31](https://github.com/inflowpayai/inflow-node/pull/31)
  [`2e041a1`](https://github.com/inflowpayai/inflow-node/commit/2e041a13818b67ea95605926c9360aa07079b47e) Thanks
  [@nkavian](https://github.com/nkavian)! - Preserve the challenge `opaque` value when forwarding verified credentials
  for redemption.

- [#31](https://github.com/inflowpayai/inflow-node/pull/31)
  [`fcf912e`](https://github.com/inflowpayai/inflow-node/commit/fcf912e9163db0779186684a86326df025bd414e) Thanks
  [@nkavian](https://github.com/nkavian)! - Require mppx 0.8.12 or newer and emit MPP receipts with `challengeId` and
  nested `settlement.amount` and `settlement.currency` fields.
- Updated dependencies
  [[`fcf912e`](https://github.com/inflowpayai/inflow-node/commit/fcf912e9163db0779186684a86326df025bd414e),
  [`56f6c8b`](https://github.com/inflowpayai/inflow-node/commit/56f6c8b9e9ad169f6bc3ee45d387dc4575946682)]:
  - @inflowpayai/mpp@0.7.1

## 0.6.1

### Patch Changes

- Updated dependencies
  [[`a81e266`](https://github.com/inflowpayai/inflow-node/commit/a81e266b523b082ddbde9b252ad4f536229e5c27),
  [`9b9ac40`](https://github.com/inflowpayai/inflow-node/commit/9b9ac40afb6ed778bf4d9bfc851312fb49d9812a)]:
  - @inflowpayai/mpp@0.7.0

## 0.6.0

### Minor Changes

- [#24](https://github.com/inflowpayai/inflow-node/pull/24)
  [`177e4c4`](https://github.com/inflowpayai/inflow-node/commit/177e4c4962613c43d111289fe8a8a28eaf068053) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Add the Tempo MPP method end to end: the shared request/credential
  schemas and types in `@inflowpayai/mpp`, seller-side challenge minting in `@inflowpayai/mpp-seller`, and buyer-side
  fulfilment in `@inflowpayai/mpp-buyer`. Tempo settles on-chain via pull-mode credentials minted by the InFlow PSP;
  fee-payer sponsorship is opt-in via `methodDetails.feePayer` and defaults to off.

### Patch Changes

- Updated dependencies
  [[`177e4c4`](https://github.com/inflowpayai/inflow-node/commit/177e4c4962613c43d111289fe8a8a28eaf068053)]:
  - @inflowpayai/mpp@0.6.0

## 0.5.2

### Patch Changes

- [#21](https://github.com/inflowpayai/inflow-node/pull/21)
  [`3106b26`](https://github.com/inflowpayai/inflow-node/commit/3106b263415b58f88189360e8187fb3703b0fc86) Thanks
  [@nkavian](https://github.com/nkavian)! - Add multi-currency seller helpers. `inflowCharges(mppx, prices)` presents
  several currencies on one route — one `WWW-Authenticate: Payment` challenge per `{ amount, currency }` via mppx's
  `compose(...)` — and returns the Web-fetch handler; `inflowChargesNodeListener(mppx, prices)` wraps it with
  `Mppx.toNodeListener` for Node/Express. Amounts are per-currency and independent, and each currency's rail is derived
  from the PSP config (crypto → `balance`, fiat → `instrument`). This is the MPP analog of `@inflowpayai/x402-seller`'s
  `inflowAccepts`, needed because the mppx framework adapters expose only the single-currency `charge` and do not expose
  `compose`. Also exports the `InflowChargePrice` type.

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
- Updated dependencies
  [[`9c18441`](https://github.com/inflowpayai/inflow-node/commit/9c18441acc9f69873c6a94690bb12d6672db5de5),
  [`9c18441`](https://github.com/inflowpayai/inflow-node/commit/9c18441acc9f69873c6a94690bb12d6672db5de5)]:
  - @inflowpayai/mpp@0.5.1
