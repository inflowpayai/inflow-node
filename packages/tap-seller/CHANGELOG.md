# @inflowpayai/tap-seller

## 0.2.2

### Patch Changes

- [#87](https://github.com/inflowpayai/inflow-node/pull/87)
  [`646933e`](https://github.com/inflowpayai/inflow-node/commit/646933ecbcafe0d4504b0530090e5b972c36e21c) Thanks
  [@nkavian](https://github.com/nkavian)! - Preserve original query spelling during TAP signature verification,
  rejecting changes between literal and percent-encoded characters.

- [#86](https://github.com/inflowpayai/inflow-node/pull/86)
  [`f78e0a6`](https://github.com/inflowpayai/inflow-node/commit/f78e0a6cd241a32602830c4d6d88ebd989b22bdc) Thanks
  [@nkavian](https://github.com/nkavian)! - Accept valid TAP signature parameter ordering and Structured Field
  serialization. Repeated parameters use their last value consistently for validation and signature verification.

  Reject non-Ed25519 key material returned by a custom key resolver.

## 0.2.1

### Patch Changes

- [#82](https://github.com/inflowpayai/inflow-node/pull/82)
  [`9592880`](https://github.com/inflowpayai/inflow-node/commit/9592880903ee923c85cad8f135b9cf42b48c622d) Thanks
  [@nkavian](https://github.com/nkavian)! - Reject requests with bodies when the signed content-type header is missing
  or ambiguous.

## 0.2.0

### Minor Changes

- [#50](https://github.com/inflowpayai/inflow-node/pull/50)
  [`71d2045`](https://github.com/inflowpayai/inflow-node/commit/71d2045ec6c02d090bad52dce6b3bf14ef133621) Thanks
  [@nkavian](https://github.com/nkavian)! - Add local Visa Trusted Agent Protocol request verification and middleware
  primitives.
