---
'@inflowpayai/x402': minor
'@inflowpayai/x402-seller': minor
---

Add uniform `extra.assetName` on every `accepts[]` entry emitted by `inflowAccepts`. The seller publishes the row's currency under a single well-known key (`EXTRA_KEYS.ASSET_NAME`) on EVM, Solana, and balance entries alike, so callers can render the currency without parsing `assetId` or branching on scheme. `X402AssetInfo` gains a required `assetName` field mirroring the server's new response field; `EXTRA_KEYS.ASSET_NAME = 'assetName'` is exported for typed access.
