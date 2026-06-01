# @inflowpayai/x402-seller

## 0.6.1

### Patch Changes

- Updated dependencies
  [[`45540f2`](https://github.com/inflowpayai/inflow-node/commit/45540f2253b1c814ae6c41daa1f4375214c7fa41)]:
  - @inflowpayai/x402@0.8.0

## 0.6.0

### Minor Changes

- [#12](https://github.com/inflowpayai/inflow-node/pull/12)
  [`ef26298`](https://github.com/inflowpayai/inflow-node/commit/ef26298a969e19c018d6f1d8b106065f36dd2d3f) Thanks
  [@nkavian](https://github.com/nkavian)! - Add uniform `extra.assetName` on every `accepts[]` entry emitted by
  `inflowAccepts`. The seller publishes the row's currency under a single well-known key (`EXTRA_KEYS.ASSET_NAME`) on
  EVM, Solana, and balance entries alike, so callers can render the currency without parsing `assetId` or branching on
  scheme. `X402AssetInfo` gains a required `assetName` field mirroring the server's new response field;
  `EXTRA_KEYS.ASSET_NAME = 'assetName'` is exported for typed access.

### Patch Changes

- Updated dependencies
  [[`ef26298`](https://github.com/inflowpayai/inflow-node/commit/ef26298a969e19c018d6f1d8b106065f36dd2d3f)]:
  - @inflowpayai/x402@0.7.0

## 0.5.4

### Patch Changes

- [#10](https://github.com/inflowpayai/inflow-node/pull/10)
  [`da9ce53`](https://github.com/inflowpayai/inflow-node/commit/da9ce5373c736e7c745f547d5933a782b595307b) Thanks
  [@nkavian](https://github.com/nkavian)! - Loosen `engines.node` from `>=22.13.0` to `>=22.0.0`. Nothing in the
  published surface depends on a 22.13-specific API: `AbortSignal.any` is feature-detected (Node 20.3+) with a manual
  fan-in fallback, native `fetch` is stable since Node 18, and no `import.meta.dirname` / `import.meta.filename`
  references exist. Widens compatibility with Linux distributions that lag on minor releases without changing runtime
  requirements.

- Updated dependencies
  [[`20435e0`](https://github.com/inflowpayai/inflow-node/commit/20435e0375998df59f5021990081dc5c5ee85df7),
  [`da9ce53`](https://github.com/inflowpayai/inflow-node/commit/da9ce5373c736e7c745f547d5933a782b595307b)]:
  - @inflowpayai/x402@0.6.0

## 0.5.3

### Patch Changes

- [#5](https://github.com/inflowpayai/inflow-node/pull/5)
  [`a61cdf6`](https://github.com/inflowpayai/inflow-node/commit/a61cdf69e6f1d839729977860879e0ccfce12ffe) Thanks
  [@nkavian](https://github.com/nkavian)! - Internal: exercise the release workflow's CDN-propagation retry in the
  verify step. No functional changes to the published API or runtime behavior.

- Updated dependencies
  [[`a61cdf6`](https://github.com/inflowpayai/inflow-node/commit/a61cdf69e6f1d839729977860879e0ccfce12ffe)]:
  - @inflowpayai/x402@0.5.3

## 0.5.2

### Patch Changes

- [#3](https://github.com/inflowpayai/inflow-node/pull/3)
  [`2120084`](https://github.com/inflowpayai/inflow-node/commit/2120084f8723f40fd6f984915efa2d92fac4a94b) Thanks
  [@nkavian](https://github.com/nkavian)! - Internal: exercise the Trusted Publishing OIDC flow and the new
  provenance-attestation verify step end-to-end. No functional changes to the published API or runtime behavior.

- Updated dependencies
  [[`2120084`](https://github.com/inflowpayai/inflow-node/commit/2120084f8723f40fd6f984915efa2d92fac4a94b)]:
  - @inflowpayai/x402@0.5.2

## 0.5.1

### Patch Changes

- [#1](https://github.com/inflowpayai/inflow-node/pull/1)
  [`7e2e601`](https://github.com/inflowpayai/inflow-node/commit/7e2e60156da9539ccb389c14dac131cfc44f2c8e) Thanks
  [@nkavian](https://github.com/nkavian)! - Verify Trusted Publishing pipeline.

- Updated dependencies
  [[`7e2e601`](https://github.com/inflowpayai/inflow-node/commit/7e2e60156da9539ccb389c14dac131cfc44f2c8e)]:
  - @inflowpayai/x402@0.5.1
