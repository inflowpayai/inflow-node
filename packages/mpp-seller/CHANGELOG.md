# @inflowpayai/mpp-seller

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
