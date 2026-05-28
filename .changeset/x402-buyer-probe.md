---
'@inflowpayai/x402-buyer': patch
---

Add `@inflowpayai/x402-buyer/probe` subpath export.

The subpath ships a small set of buyer-side helpers that pair with
`createInflowClient` for callers that need to drive the 402 → sign →
replay loop themselves:

- `sellerProbe(url, options)` — a `fetch` wrapper that captures
  `{ status, headers, bytes, contentType }` without interpreting the
  body. Useful when the same response will be inspected for a
  PAYMENT-REQUIRED header or replayed with a signed payload.
- `replayWithPayment(url, options)` — same as `sellerProbe` plus the
  `PAYMENT-SIGNATURE` header pre-attached.
- `describeBody(bytes)` — best-effort UTF-8 decode + base64 mirror +
  byte count. Lets the caller decide between inline text, inline
  base64, or size-only display.
- `parseHeaderFlag(input)` / `parseHeaderFlags(inputs)` — parse
  CLI-style `"Name: Value"` header flags into a `Record`. Throws
  `X402HeaderFlagFormatError` on bad input.
- `X402HeaderFlagFormatError` — typed error class for header-flag
  parse failures. Follows the package's existing `X402<Thing><Reason>Error`
  naming convention.

Strictly additive: no existing exports change. The new helpers are
gated behind the `/probe` subpath so signing-only consumers don't pull
this code.
