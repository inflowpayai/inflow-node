---
'@inflowpayai/mpp': minor
---

Preserve the challenge `opaque` blob through parse, render, and the echoed credential `challenge` so a seller can recompute its HMAC challenge binding, and add optional `amount`/`currency` settlement fields to `MppReceipt` for reconciliation.
