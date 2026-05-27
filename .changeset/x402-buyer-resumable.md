---
'@inflowpayai/x402-buyer': minor
---

Add four public methods to `InflowClient` for callers without an in-process `PreparedPayment`: `getSupported`, `selectInflowRequirement`, `getX402Payload`, `cancelApproval`. Lets a separate process resume polling on an existing `transactionId` or cancel an existing `approvalId` without re-entering the `prepareInflowPayment` flow. Also re-exports `fromFoundationRequirements` from the barrel so callers that decode a `PaymentRequired` via `@x402/core/http` can convert the foundation `accepts[]` into the InFlow `PaymentRequirements[]` shape that the rest of the buyer surface speaks.
