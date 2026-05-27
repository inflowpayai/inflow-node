---
'@inflowpayai/x402': patch
'@inflowpayai/x402-buyer': patch
'@inflowpayai/x402-seller': patch
---

Loosen `engines.node` from `>=22.13.0` to `>=22.0.0`. Nothing in the published surface depends on a 22.13-specific API: `AbortSignal.any` is feature-detected (Node 20.3+) with a manual fan-in fallback, native `fetch` is stable since Node 18, and no `import.meta.dirname` / `import.meta.filename` references exist. Widens compatibility with Linux distributions that lag on minor releases without changing runtime requirements.
