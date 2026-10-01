---
'@inflowpayai/mpp-seller': minor
---

Add an async Stripe charge method that uses the official mppx wire schema, loads the authenticated seller profile from
InFlow, validates exact USD limits before challenge issuance, binds credential references to seller-provided references,
and delegates validation and settlement to the PSP. Document the Stripe Connect setup required for sellers.
