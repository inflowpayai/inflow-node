---
'@inflowpayai/x402-seller': patch
---

Only normalize HTTP 412 verification responses when they report a failed Permit2 allowance check. Preserve unrelated or
malformed responses as HTTP errors.
