---
'@inflowpayai/x402': patch
'@inflowpayai/x402-buyer': patch
---

Add `normalizeDecimalString` and apply it to buyer ledger balances (`getBalances`), collapsing padded decimal strings
like `0.010000000000000000` to `0.01` for display. Facilitator settle responses are left untouched.
