# @inflowpayai/x402

## 0.10.0

### Minor Changes

- [#62](https://github.com/inflowpayai/inflow-node/pull/62)
  [`91961c5`](https://github.com/inflowpayai/inflow-node/commit/91961c5a3aa09dda15f7268e7e8f1c058111e8b0) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Add opt-in external-wallet EIP-7702 sponsorship through the buyer's
  optional `eip7702` subpath and capability-gated seller route declarations. Validate hosted preparation against the
  exact approval and Permit2 payment before requesting delegation and operation signatures. Preserve standard EIP-2612
  and managed-buyer routing.

- [#61](https://github.com/inflowpayai/inflow-node/pull/61)
  [`dd0f98b`](https://github.com/inflowpayai/inflow-node/commit/dd0f98b4052db4fec03d819890f824c32dd49a5e) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Add explicit seller-side `upto` selection using advertised Permit2
  capabilities and the foundation EVM scheme server. Keep exact and balance defaults, load the optional EVM peer only
  for metered registrations, and document measured settlement through the foundation adapter's `setSettlementOverrides`
  API.

- [#62](https://github.com/inflowpayai/inflow-node/pull/62)
  [`91961c5`](https://github.com/inflowpayai/inflow-node/commit/91961c5a3aa09dda15f7268e7e8f1c058111e8b0) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Add token capability metadata and an `inflowRoute` companion helper
  for explicitly selected Permit2 offers and gated EIP-2612 sponsorship declarations. Keep Permit2 payments on
  external-wallet signing paths, excluding InFlow-managed treasury signing.

### Patch Changes

- [#69](https://github.com/inflowpayai/inflow-node/pull/69)
  [`cbf1707`](https://github.com/inflowpayai/inflow-node/commit/cbf17075a6a02ae4aa4d1b655c64bbd69e28eeca) Thanks
  [@nkavian](https://github.com/nkavian)! - Preserve TIMEOUT errors when native fetch replaces an internal abort reason,
  including timeouts while reading response bodies.

- [#68](https://github.com/inflowpayai/inflow-node/pull/68)
  [`bfa2c3f`](https://github.com/inflowpayai/inflow-node/commit/bfa2c3f88b6f0c104f39887dce15779b88d42885) Thanks
  [@nkavian](https://github.com/nkavian)! - Require x402 foundation 2.27.0 for protected-route fixes and updated
  external-wallet spending controls. Update framework compatibility coverage and custom-mint example configuration.
  Fastify remains on its published 2.26.0 adapter and does not receive the 2.27.0 route fix.

  Apply registered policies and declared extension lifecycle hooks to managed payments. Run before and after hooks for
  two-phase payments while preserving their server payload, cancellation, and shared completion behavior.

## 0.9.1

### Patch Changes

- [#56](https://github.com/inflowpayai/inflow-node/pull/56)
  [`8ca7290`](https://github.com/inflowpayai/inflow-node/commit/8ca729022e9c2520eb5b1848ded7378eac44d76e) Thanks
  [@nkavian](https://github.com/nkavian)! - Encode x402 payment identifiers using the standard extension envelope.

## 0.9.0

### Minor Changes

- [#40](https://github.com/inflowpayai/inflow-node/pull/40)
  [`c95b2ea`](https://github.com/inflowpayai/inflow-node/commit/c95b2eaa3db29aa91a551a54898761343cecf98c) Thanks
  [@nkavian](https://github.com/nkavian)! - Require the hardened x402 foundation 2.22 release across the SDK suite,
  including its protections for encoded separators, bare wildcard prefixes, and encoded line terminators in route
  matching. Seller scheme registrations now declare authorization-only payment flows for exactly the asset transfer
  methods emitted by InFlow seller config, preserving the existing verify-before-handler and settle-after-handler
  behavior while adopting the current foundation contract.

## 0.8.1

### Patch Changes

- [#26](https://github.com/inflowpayai/inflow-node/pull/26)
  [`22ea453`](https://github.com/inflowpayai/inflow-node/commit/22ea453c152757f1f1a8ec7aa73e44edfa3eacc8) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Add `normalizeDecimalString` and apply it to buyer ledger balances
  (`getBalances`), collapsing padded decimal strings like `0.010000000000000000` to `0.01` for display. Facilitator
  settle responses are left untouched.

- [#27](https://github.com/inflowpayai/inflow-node/pull/27)
  [`9b9ac40`](https://github.com/inflowpayai/inflow-node/commit/9b9ac40afb6ed778bf4d9bfc851312fb49d9812a) Thanks
  [@nkavian](https://github.com/nkavian)! - Tighten static analysis settings and clean up newly enforced TypeScript and
  ESLint diagnostics.

## 0.8.0

### Minor Changes

- [#17](https://github.com/inflowpayai/inflow-node/pull/17)
  [`45540f2`](https://github.com/inflowpayai/inflow-node/commit/45540f2253b1c814ae6c41daa1f4375214c7fa41) Thanks
  [@nkavian](https://github.com/nkavian)! - Add `INFLOW_AMOUNT_SCALE` (the `inflow:1` atomic-unit scale, 1e18) to
  `@inflowpayai/x402` and export it from the package root. Add the `firstErrorEntry` helper for reading the InFlow
  `{ errors: [...] }` envelope, and reshape `InflowApiError.from()` so `.message` is the server's human-readable message
  while transport details (`endpoint`, `httpStatus`, `requestId`, `code`, `body`) are carried as instance fields rather
  than folded into the message string.

  `@inflowpayai/x402-buyer` gains a buyer-side signer module and an expanded `InflowClient` surface.

## 0.7.0

### Minor Changes

- [#12](https://github.com/inflowpayai/inflow-node/pull/12)
  [`ef26298`](https://github.com/inflowpayai/inflow-node/commit/ef26298a969e19c018d6f1d8b106065f36dd2d3f) Thanks
  [@nkavian](https://github.com/nkavian)! - Add uniform `extra.assetName` on every `accepts[]` entry emitted by
  `inflowAccepts`. The seller publishes the row's currency under a single well-known key (`EXTRA_KEYS.ASSET_NAME`) on
  EVM, Solana, and balance entries alike, so callers can render the currency without parsing `assetId` or branching on
  scheme. `X402AssetInfo` gains a required `assetName` field mirroring the server's new response field;
  `EXTRA_KEYS.ASSET_NAME = 'assetName'` is exported for typed access.

## 0.6.0

### Minor Changes

- [#7](https://github.com/inflowpayai/inflow-node/pull/7)
  [`20435e0`](https://github.com/inflowpayai/inflow-node/commit/20435e0375998df59f5021990081dc5c5ee85df7) Thanks
  [@nkavian](https://github.com/nkavian)! - Add `InflowBearerClientOptions` for callers that authenticate with an OAuth
  Bearer token instead of an API key. The new options shape is mutually exclusive with `apiKey`; both at once throws at
  construction. `getAccessToken` is invoked once per HTTP request — callers should cache and proactively refresh
  upstream of this callback.

### Patch Changes

- [#10](https://github.com/inflowpayai/inflow-node/pull/10)
  [`da9ce53`](https://github.com/inflowpayai/inflow-node/commit/da9ce5373c736e7c745f547d5933a782b595307b) Thanks
  [@nkavian](https://github.com/nkavian)! - Loosen `engines.node` from `>=22.13.0` to `>=22.0.0`. Nothing in the
  published surface depends on a 22.13-specific API: `AbortSignal.any` is feature-detected (Node 20.3+) with a manual
  fan-in fallback, native `fetch` is stable since Node 18, and no `import.meta.dirname` / `import.meta.filename`
  references exist. Widens compatibility with Linux distributions that lag on minor releases without changing runtime
  requirements.

## 0.5.3

### Patch Changes

- [#5](https://github.com/inflowpayai/inflow-node/pull/5)
  [`a61cdf6`](https://github.com/inflowpayai/inflow-node/commit/a61cdf69e6f1d839729977860879e0ccfce12ffe) Thanks
  [@nkavian](https://github.com/nkavian)! - Internal: exercise the release workflow's CDN-propagation retry in the
  verify step. No functional changes to the published API or runtime behavior.

## 0.5.2

### Patch Changes

- [#3](https://github.com/inflowpayai/inflow-node/pull/3)
  [`2120084`](https://github.com/inflowpayai/inflow-node/commit/2120084f8723f40fd6f984915efa2d92fac4a94b) Thanks
  [@nkavian](https://github.com/nkavian)! - Internal: exercise the Trusted Publishing OIDC flow and the new
  provenance-attestation verify step end-to-end. No functional changes to the published API or runtime behavior.

## 0.5.1

### Patch Changes

- [#1](https://github.com/inflowpayai/inflow-node/pull/1)
  [`7e2e601`](https://github.com/inflowpayai/inflow-node/commit/7e2e60156da9539ccb389c14dac131cfc44f2c8e) Thanks
  [@nkavian](https://github.com/nkavian)! - Verify Trusted Publishing pipeline.
