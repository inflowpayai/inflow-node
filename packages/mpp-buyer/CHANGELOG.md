# @inflowpayai/mpp-buyer

## 0.7.1

### Patch Changes

- Updated dependencies
  [[`2b6f377`](https://github.com/inflowpayai/inflow-node/commit/2b6f377181d45ffb969674460667903f34ce6e17)]:
  - @inflowpayai/mpp@0.9.0

## 0.7.0

### Minor Changes

- [#38](https://github.com/inflowpayai/inflow-node/pull/38)
  [`d1cbebe`](https://github.com/inflowpayai/inflow-node/commit/d1cbebe9ad2e61ecfa23331b5cbaf9be5a035859) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Expose the mppx in-place MCP client wrapper through the optional
  `@inflowpayai/mpp-buyer/mcp` entrypoint.

- [#42](https://github.com/inflowpayai/inflow-node/pull/42)
  [`fd4727f`](https://github.com/inflowpayai/inflow-node/commit/fd4727f3771fa9fef4617bca3be03b3cf3447d9e) Thanks
  [@nkavian](https://github.com/nkavian)! - Advertise settlement rails by intent and currency, require an explicit rail
  when the available choice is ambiguous, and validate InFlow subscription terms against the server contract.
  Subscription seller helpers accept multiple plans in one currency, subscription receipts preserve the server-issued
  identifier and seller reconciliation metadata, and clients can derive stable option fingerprints without volatile
  challenge or expiration fields.

### Patch Changes

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
  [`fcf912e`](https://github.com/inflowpayai/inflow-node/commit/fcf912e9163db0779186684a86326df025bd414e) Thanks
  [@nkavian](https://github.com/nkavian)! - Require mppx 0.8.12 or newer and emit MPP receipts with `challengeId` and
  nested `settlement.amount` and `settlement.currency` fields.
- Updated dependencies
  [[`fcf912e`](https://github.com/inflowpayai/inflow-node/commit/fcf912e9163db0779186684a86326df025bd414e),
  [`56f6c8b`](https://github.com/inflowpayai/inflow-node/commit/56f6c8b9e9ad169f6bc3ee45d387dc4575946682)]:
  - @inflowpayai/mpp@0.7.1

## 0.6.1

### Patch Changes

- [#27](https://github.com/inflowpayai/inflow-node/pull/27)
  [`9b9ac40`](https://github.com/inflowpayai/inflow-node/commit/9b9ac40afb6ed778bf4d9bfc851312fb49d9812a) Thanks
  [@nkavian](https://github.com/nkavian)! - Tighten static analysis settings and clean up newly enforced TypeScript and
  ESLint diagnostics.

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
