---
'@inflowpayai/x402-buyer': minor
---

Support explicit builder attribution for managed payments, including prepared payments. Preserve seller and buyer codes
using native x402 merging and submit them before approval creation so the payment service can persist the canonical
payload for later retrieval. Retain payment identifiers and keep encoded headers consistent with attributed payloads.
