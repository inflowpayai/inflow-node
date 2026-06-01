---
'@inflowpayai/x402': minor
'@inflowpayai/x402-buyer': minor
---

Add `INFLOW_AMOUNT_SCALE` (the `inflow:1` atomic-unit scale, 1e18) to `@inflowpayai/x402` and export it from the package
root. Add the `firstErrorEntry` helper for reading the InFlow `{ errors: [...] }` envelope, and reshape
`InflowApiError.from()` so `.message` is the server's human-readable message while transport details (`endpoint`,
`httpStatus`, `requestId`, `code`, `body`) are carried as instance fields rather than folded into the message string.

`@inflowpayai/x402-buyer` gains a buyer-side signer module and an expanded `InflowClient` surface.
