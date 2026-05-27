# @inflowpayai/x402

## 0.6.0

### Minor Changes

- [#7](https://github.com/inflowpayai/inflow-node/pull/7) [`20435e0`](https://github.com/inflowpayai/inflow-node/commit/20435e0375998df59f5021990081dc5c5ee85df7) Thanks [@nkavian](https://github.com/nkavian)! - Add `InflowBearerClientOptions` for callers that authenticate with an OAuth Bearer token instead of an API key. The new options shape is mutually exclusive with `apiKey`; both at once throws at construction. `getAccessToken` is invoked once per HTTP request — callers should cache and proactively refresh upstream of this callback.

### Patch Changes

- [#10](https://github.com/inflowpayai/inflow-node/pull/10) [`da9ce53`](https://github.com/inflowpayai/inflow-node/commit/da9ce5373c736e7c745f547d5933a782b595307b) Thanks [@nkavian](https://github.com/nkavian)! - Loosen `engines.node` from `>=22.13.0` to `>=22.0.0`. Nothing in the published surface depends on a 22.13-specific API: `AbortSignal.any` is feature-detected (Node 20.3+) with a manual fan-in fallback, native `fetch` is stable since Node 18, and no `import.meta.dirname` / `import.meta.filename` references exist. Widens compatibility with Linux distributions that lag on minor releases without changing runtime requirements.

## 0.5.3

### Patch Changes

- [#5](https://github.com/inflowpayai/inflow-node/pull/5) [`a61cdf6`](https://github.com/inflowpayai/inflow-node/commit/a61cdf69e6f1d839729977860879e0ccfce12ffe) Thanks [@nkavian](https://github.com/nkavian)! - Internal: exercise the release workflow's CDN-propagation retry in the verify step. No functional changes to the published API or runtime behavior.

## 0.5.2

### Patch Changes

- [#3](https://github.com/inflowpayai/inflow-node/pull/3) [`2120084`](https://github.com/inflowpayai/inflow-node/commit/2120084f8723f40fd6f984915efa2d92fac4a94b) Thanks [@nkavian](https://github.com/nkavian)! - Internal: exercise the Trusted Publishing OIDC flow and the new provenance-attestation verify step end-to-end. No functional changes to the published API or runtime behavior.

## 0.5.1

### Patch Changes

- [#1](https://github.com/inflowpayai/inflow-node/pull/1) [`7e2e601`](https://github.com/inflowpayai/inflow-node/commit/7e2e60156da9539ccb389c14dac131cfc44f2c8e) Thanks [@nkavian](https://github.com/nkavian)! - Verify Trusted Publishing pipeline.
