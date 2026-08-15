---
'@inflowpayai/x402': minor
'@inflowpayai/x402-buyer': minor
'@inflowpayai/x402-seller': minor
---

Require the hardened x402 foundation 2.22 release across the SDK suite, including its protections for encoded
separators, bare wildcard prefixes, and encoded line terminators in route matching. Seller scheme registrations now
declare authorization-only payment flows for exactly the asset transfer methods emitted by InFlow seller config,
preserving the existing verify-before-handler and settle-after-handler behavior while adopting the current foundation
contract.
