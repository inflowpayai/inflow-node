---
'@inflowpayai/tap-seller': patch
---

Accept valid TAP signature parameter ordering and Structured Field serialization. Repeated parameters use their last
value consistently for validation and signature verification.

Reject non-Ed25519 key material returned by a custom key resolver.
