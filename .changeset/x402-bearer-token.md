---
'@inflowpayai/x402': minor
---

Add `InflowBearerClientOptions` for callers that authenticate with an OAuth Bearer token instead of an API key. The new options shape is mutually exclusive with `apiKey`; both at once throws at construction. `getAccessToken` is invoked once per HTTP request — callers should cache and proactively refresh upstream of this callback.
