# @inflowpayai/mpp-buyer

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
