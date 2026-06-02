# @inflowpayai/mpp-seller

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
