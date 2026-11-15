---
'@inflowpayai/mpp': minor
'@inflowpayai/mpp-buyer': minor
'@inflowpayai/mpp-seller': minor
'@inflowpayai/x402': minor
'@inflowpayai/x402-buyer': minor
'@inflowpayai/x402-seller': minor
---

Upgrade the supported MPP and x402 foundations. Add optional method-specific MPP buyer limits checked during offer
selection and before requesting payment credentials.

Support explicit per-request cancellation through MPP buyer context signals without sending them to the payment server
or cancelling other requests sharing the method.

Expose request-local HTTP response headers and forward facilitator extension-response metadata to seller hooks without
including it in buyer payment receipts.

Preserve the facilitator's advertised Solana transaction versions in seller payment requirements.

Preserve alternate MPP credential headers through challenge parsing and buyer/seller forwarding so payment credentials
can coexist with application authorization.

Expose upstream payment-header codecs and their wire types through `@inflowpayai/x402/http`.
