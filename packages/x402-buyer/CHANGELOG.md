# @inflowpayai/x402-buyer

## 0.6.1

### Patch Changes

- Updated dependencies [[`ef26298`](https://github.com/inflowpayai/inflow-node/commit/ef26298a969e19c018d6f1d8b106065f36dd2d3f)]:
  - @inflowpayai/x402@0.7.0

## 0.6.0

### Minor Changes

- [#7](https://github.com/inflowpayai/inflow-node/pull/7) [`20435e0`](https://github.com/inflowpayai/inflow-node/commit/20435e0375998df59f5021990081dc5c5ee85df7) Thanks [@nkavian](https://github.com/nkavian)! - `SignerOptions` now accepts `InflowAnonymousClientOptions` and `InflowBearerClientOptions` in addition to `InflowClientOptions`. The type changed from `interface extends InflowClientOptions` to a discriminated union; existing API-key callers see no behavior change.

- [#9](https://github.com/inflowpayai/inflow-node/pull/9) [`53b3b9f`](https://github.com/inflowpayai/inflow-node/commit/53b3b9f993bcb1a0a8e45900b5f5bff9c3eae24d) Thanks [@nkavian](https://github.com/nkavian)! - Add four public methods to `InflowClient` for callers without an in-process `PreparedPayment`: `getSupported`, `selectInflowRequirement`, `getX402Payload`, `cancelApproval`. Lets a separate process resume polling on an existing `transactionId` or cancel an existing `approvalId` without re-entering the `prepareInflowPayment` flow. Also re-exports `fromFoundationRequirements` from the barrel so callers that decode a `PaymentRequired` via `@x402/core/http` can convert the foundation `accepts[]` into the InFlow `PaymentRequirements[]` shape that the rest of the buyer surface speaks.

### Patch Changes

- [#10](https://github.com/inflowpayai/inflow-node/pull/10) [`da9ce53`](https://github.com/inflowpayai/inflow-node/commit/da9ce5373c736e7c745f547d5933a782b595307b) Thanks [@nkavian](https://github.com/nkavian)! - Loosen `engines.node` from `>=22.13.0` to `>=22.0.0`. Nothing in the published surface depends on a 22.13-specific API: `AbortSignal.any` is feature-detected (Node 20.3+) with a manual fan-in fallback, native `fetch` is stable since Node 18, and no `import.meta.dirname` / `import.meta.filename` references exist. Widens compatibility with Linux distributions that lag on minor releases without changing runtime requirements.

- Updated dependencies [[`20435e0`](https://github.com/inflowpayai/inflow-node/commit/20435e0375998df59f5021990081dc5c5ee85df7), [`da9ce53`](https://github.com/inflowpayai/inflow-node/commit/da9ce5373c736e7c745f547d5933a782b595307b)]:
  - @inflowpayai/x402@0.6.0

## 0.5.3

### Patch Changes

- [#5](https://github.com/inflowpayai/inflow-node/pull/5) [`a61cdf6`](https://github.com/inflowpayai/inflow-node/commit/a61cdf69e6f1d839729977860879e0ccfce12ffe) Thanks [@nkavian](https://github.com/nkavian)! - Internal: exercise the release workflow's CDN-propagation retry in the verify step. No functional changes to the published API or runtime behavior.

- Updated dependencies [[`a61cdf6`](https://github.com/inflowpayai/inflow-node/commit/a61cdf69e6f1d839729977860879e0ccfce12ffe)]:
  - @inflowpayai/x402@0.5.3

## 0.5.2

### Patch Changes

- [#3](https://github.com/inflowpayai/inflow-node/pull/3) [`2120084`](https://github.com/inflowpayai/inflow-node/commit/2120084f8723f40fd6f984915efa2d92fac4a94b) Thanks [@nkavian](https://github.com/nkavian)! - Internal: exercise the Trusted Publishing OIDC flow and the new provenance-attestation verify step end-to-end. No functional changes to the published API or runtime behavior.

- Updated dependencies [[`2120084`](https://github.com/inflowpayai/inflow-node/commit/2120084f8723f40fd6f984915efa2d92fac4a94b)]:
  - @inflowpayai/x402@0.5.2

## 0.5.1

### Patch Changes

- [#1](https://github.com/inflowpayai/inflow-node/pull/1) [`7e2e601`](https://github.com/inflowpayai/inflow-node/commit/7e2e60156da9539ccb389c14dac131cfc44f2c8e) Thanks [@nkavian](https://github.com/nkavian)! - Verify Trusted Publishing pipeline.

- Updated dependencies [[`7e2e601`](https://github.com/inflowpayai/inflow-node/commit/7e2e60156da9539ccb389c14dac131cfc44f2c8e)]:
  - @inflowpayai/x402@0.5.1
