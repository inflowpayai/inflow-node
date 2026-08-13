---
'@inflowpayai/mpp': patch
'@inflowpayai/mpp-seller': patch
---

Align MPP problem handling and receipt parsing with the current protocol while preserving existing wire behavior.

- Parse and expose optional `hint` and `details` on `MppProblemDetail`.
- Sanitise `extensions` so it cannot override canonical RFC 9457 fields, top-level `hint`/`details`, or challenge
  identifiers.
- Preserve forward-compatible, method-specific top-level receipt fields from `/v1/mpp/redeem` responses when translating
  to mppx receipts, including the InFlow server's optional external and subscription identifiers.
