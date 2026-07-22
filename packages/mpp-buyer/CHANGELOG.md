# @inflowpayai/mpp-buyer

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
