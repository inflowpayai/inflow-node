---
'@inflowpayai/mpp': minor
'@inflowpayai/mpp-seller': patch
'@inflowpayai/x402': minor
---

Expose the optional seller-accessible InFlow transaction ID in MPP receipts and provide `getInflowTransactionId` for
x402 settlement extensions. Preserve MPP correlation through receipt conversion even when unrelated extensions reach
their size limit. Existing settlement references and payment behavior are unchanged, and receipts without correlation
remain supported.
