---
'@inflowpayai/x402-buyer': minor
---

`SignerOptions` now accepts `InflowAnonymousClientOptions` and `InflowBearerClientOptions` in addition to `InflowClientOptions`. The type changed from `interface extends InflowClientOptions` to a discriminated union; existing API-key callers see no behavior change.
