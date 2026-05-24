# @inflowpayai/x402

Core types, HTTP client, and shared constants for the [InFlow x402 SDK](https://github.com/inflowpayai/inflow-node/tree/main/docs/x402).

This package is a transitive dependency of `@inflowpayai/x402-seller*` and `@inflowpayai/x402-buyer*`. Most integrations don't install it directly.

## Install

```bash
pnpm add @inflowpayai/x402 @x402/core
```

`@x402/core` is a peer dependency. Co-install it on the consumer side so package managers can warn loudly when it's missing.

## What's exported

### Main entry — `@inflowpayai/x402`

- `InflowHttpClient` — the shared HTTP client used by every other package in this monorepo. Carries `X-API-KEY` injection, JSON parsing,
  per-request timeout, retry on transient statuses (`429`, `502`, `503`, `504`) with exponential backoff capped at three attempts, and error
  mapping into `InflowApiError`.
- `resolveBaseUrl(options)` — returns the API base URL for an `Environment` (`'production' | 'sandbox'`) or a `baseUrl` override.
- `InflowApiError`, `X402VersionMismatchError` — typed errors raised by the client.
- Constants — `X402_VERSION`, `HEADERS`, `SCHEMES`, `NETWORKS`, `CONTRACTS`, `EXTRA_KEYS`, `PAYLOAD_KEYS`, `ASSET_TRANSFER_METHODS`.
- Wire-shape types — `PaymentRequirements`, `PaymentRequired`, `SettleResponse`, `VerifyResponse`, `ResourceInfo`, `PaymentScheme`, `InstrumentType`.
- InFlow-specific types — `X402ConfigResponse`, `X402AssetInfo`, `X402WalletInfo`, `PaymentMethodInfo`,
  `X402FacilitatorSupportedResponse`, `X402BuyerSupportedResponse`, `X402SupportedKind`, `InflowPaymentPayload`, `BalancePayloadData`,
  `ExactPayloadData`, `Permit2PayloadData`, `InstrumentPayloadData`.
- Narrowing helpers — `isBalancePayload`, `isExactPayload`, `isPermit2Payload`, `isInstrumentPayload`.
- `readHeader(headers, name)` — case-insensitive header read for WHATWG `Headers`, Node `IncomingHttpHeaders`-style records, or plain
  `Record<string, string | string[] | undefined>`.

### `@inflowpayai/x402/extensions`

- `ExtensionHandler<TDecl, TPayloadEntry>` — pluggable handler contract.
- `PAYMENT_IDENTIFIER` — handler for the `payment-identifier` extension.
- `validatePaymentId(id)` / `generatePaymentId(prefix?)` — format validation and generation.
- `getExtension<TDecl>(extensions, handler)` / `setExtension<TDecl>(extensions, handler, value)` — typed accessor
  helpers for `PaymentRequired.extensions` / `PaymentPayload.extensions`.
- `EXTENSION_REGISTRY` — registry of every handler the SDK ships with, keyed by extension name.

### `@inflowpayai/x402/extras`

- `getExtra<T>(extra, key)` / `setExtra<T>(extra, key, value)` — open-key analogs of the extension helpers, for `PaymentRequirements.extra`,
  `PaymentMethodInfo.extra`, and similar bag fields.

### `@inflowpayai/x402/security`

- `timingSafeEqualStrings(a, b)` — constant-time string equality.

## Example — `InflowHttpClient`

```ts
import { InflowHttpClient, InflowApiError } from '@inflowpayai/x402';

const http = new InflowHttpClient({
  apiKey: process.env.INFLOW_API_KEY!,
  environment: 'sandbox',
});

try {
  const config = await http.get('/v1/x402/config');
  console.log(config);
} catch (err) {
  if (err instanceof InflowApiError) {
    console.error(`[${err.requestId ?? '-'}] ${err.code} (${err.httpStatus})`);
  } else {
    throw err;
  }
}
```

## See also

- [@inflowpayai/x402-seller](../x402-seller) — framework-agnostic seller core
- [@inflowpayai/x402-buyer](../x402-buyer) — framework-agnostic buyer core
- [Product overview](../../docs/x402/README.md)
- [Architecture](../../docs/x402/architecture.md) — InFlow vs. foundation responsibilities, request lifecycle, conflict precedence
- [Wire-format mapping](../../docs/x402/protocol-mapping.md) — types, headers, network rules, decimals
- [Extensions](../../docs/x402/extensions.md) — `payment-identifier` end-to-end

## License

MIT.
