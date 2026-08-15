---
'@inflowpayai/mpp': patch
'@inflowpayai/mpp-buyer': patch
'@inflowpayai/mpp-seller': patch
---

Require mppx 0.8.17 for current discovery and composed-offer behavior.

Expose request-aware `canOffer` hooks on the InFlow and Tempo seller method constructors.

Re-export discovery helpers so buyers can normalize legacy metadata and sellers can emit canonical
`x-payment-info.offers[]` documents. Document server-wide `selectOffers` policy alongside method-level gating.
