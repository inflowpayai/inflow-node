---
'@inflowpayai/mpp-seller': patch
---

Add multi-currency seller helpers. `inflowCharges(mppx, prices)` presents several currencies on one route — one
`WWW-Authenticate: Payment` challenge per `{ amount, currency }` via mppx's `compose(...)` — and returns the Web-fetch
handler; `inflowChargesNodeListener(mppx, prices)` wraps it with `Mppx.toNodeListener` for Node/Express. Amounts are
per-currency and independent, and each currency's rail is derived from the PSP config (crypto → `balance`, fiat →
`instrument`). This is the MPP analog of `@inflowpayai/x402-seller`'s `inflowAccepts`, needed because the mppx framework
adapters expose only the single-currency `charge` and do not expose `compose`. Also exports the `InflowChargePrice`
type.
