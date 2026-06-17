---
'@inflowpayai/mpp': minor
'@inflowpayai/mpp-buyer': minor
'@inflowpayai/mpp-seller': minor
---

Add the Tempo MPP method end to end: the shared request/credential schemas and types in `@inflowpayai/mpp`, seller-side
challenge minting in `@inflowpayai/mpp-seller`, and buyer-side fulfilment in `@inflowpayai/mpp-buyer`. Tempo settles
on-chain via pull-mode credentials minted by the InFlow PSP; fee-payer sponsorship is opt-in via
`methodDetails.feePayer` and defaults to off.
