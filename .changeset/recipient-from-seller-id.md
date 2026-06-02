---
'@inflowpayai/mpp': patch
'@inflowpayai/mpp-seller': patch
---

Source the challenge `recipient` from the authenticated seller. `GET /v1/mpp/config` now returns the seller's
`sellerId`, and the seller `inflow` method stamps it as the `recipient` on every minted challenge. Adds `sellerId` to
the `MppConfigResponse` type (`@inflowpayai/mpp`) and removes the `recipient` option from `InflowSellerParameters`
(`@inflowpayai/mpp-seller`) — the recipient is no longer caller-supplied. Fixes the server rejecting fulfilment with
`invalid-challenge: "Recipient or sender is missing."`
