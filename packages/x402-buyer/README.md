# @inflowpayai/x402-buyer

Buyer-side InFlow primitives that plug into the foundation V2 buyer transport (`x402HTTPClient` from `@x402/core`). This package ships
**`InflowClient`** — a subclass of `@x402/core`'s `x402Client` that routes InFlow-acceptable `(scheme, network)` pairs through the InFlow
MPC signing flow and delegates everything else to foundation-managed schemes registered on the same instance.

## Install

```bash
pnpm add @inflowpayai/x402-buyer @x402/core
# …add @x402/evm or @x402/svm as needed for on-chain signing
```

`@inflowpayai/x402` is a runtime dependency (bundled via workspace); `@x402/core` is a peer dependency.

## What's exported

- `createInflowClient(options)` — async factory. Returns a primed `InflowClient`. Primes the buyer capability cache before
  resolving, so the routing decision inside `createPaymentPayload` is synchronous against in-memory data.
- `InflowClient` — `extends @x402/core/client.x402Client`. Overrides `createPaymentPayload` to route to InFlow first and fall back to
  foundation-registered schemes. Adds `prepareInflowPayment` for callers that want to surface pending-approval UI before the protected
  request is replayed.
- `parseEvmPrivateKey`, `decodeSolanaSecret` — key-decoding helpers for callers wiring up foundation EVM/SVM schemes from existing
  InFlow-managed wallet exports.
- Typed errors: `X402AdapterRoutingError`, `X402ApprovalCancelledError`, `X402ApprovalFailedError`, `X402ApprovalTimeoutError`,
  `X402PaymentIdFormatError`, `X402InvalidEvmKeyError`, `X402InvalidSolanaKeyError`.

## Quickstart

```ts
import { createInflowClient } from '@inflowpayai/x402-buyer';
import { x402HTTPClient } from '@x402/core/client';

const core = await createInflowClient({
  apiKey: process.env.INFLOW_API_KEY!,
  environment: 'sandbox',
});
const http = new x402HTTPClient(core);

const initial = await fetch('https://api.example.com/widgets');
if (initial.status === 402) {
  const paymentRequired = http.getPaymentRequiredResponse((n) => initial.headers.get(n));
  const paymentPayload = await http.createPaymentPayload(paymentRequired);
  const paymentHeaders = http.encodePaymentSignatureHeader(paymentPayload);
  const paid = await fetch('https://api.example.com/widgets', { headers: paymentHeaders });
  const result = await http.processResponse(paid);
  if (result.kind === 'success') {
    console.log(result.body, result.settleResponse.transaction);
  }
}
```

The same composition works with axios — see [`examples/x402-buyer-axios`](../../examples/x402-buyer-axios) for the variant that swaps `fetch`
for an axios call and decodes the response header with `decodePaymentResponseHeader` from `@x402/core/http`.

## Composing with foundation schemes

`InflowClient` extends `@x402/core`'s `x402Client`, so foundation registration helpers accept it directly:

```ts
import { createInflowClient } from '@inflowpayai/x402-buyer';
import { x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';

const core = await createInflowClient({ apiKey, environment: 'sandbox' });
registerExactEvmScheme(core, { signer: evmAccount, networks: ['eip155:1'] });
registerExactSvmScheme(core, { signer: svmKeypair, networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] });

const http = new x402HTTPClient(core);
```

When the seller's 402 offers a requirement InFlow signs (`balance/inflow:1`, or any `(scheme, network)` advertised by the buyer capability
cache), the InFlow path wins. Otherwise the foundation's selector routes to whatever EVM or SVM scheme the caller registered. The
foundation methods (`register`, `registerPolicy`, `onBeforePaymentCreation`, …) are return-type narrowed to `this` so chaining preserves
the `InflowClient` type.

## Two-phase signing (pending-approval UI)

For callers that want to surface a pending-approval state to the user before the protected request is replayed, `prepareInflowPayment`
returns a `PreparedPayment` handle:

```ts
const prepared = await core.prepareInflowPayment(requirement, {
  resource: paymentRequired.resource,
  x402Version: paymentRequired.x402Version,
});
console.log(`approval ${prepared.approvalId} pending — show dashboard prompt`);

try {
  const payment = await prepared.awaitPayload({ timeoutMs: 5 * 60 * 1000 });
  console.log(payment.encodedPayload);
} catch (err) {
  void prepared.cancel(); // fire-and-forget; never rejects
  throw err;
}
```

The two-phase flow is InFlow-specific — there's no foundation equivalent. `prepareInflowPayment` throws `X402AdapterRoutingError` if
the requirement is not in the InFlow buyer capability cache.

## Signing timeouts

`SignOptions.timeoutMs` defaults to **15 minutes** to match the server-side approval expiry. `SignOptions.pollIntervalMs` defaults to
**5 seconds** — caller-overridable, no jitter or backoff. Transient 5xx errors during a single poll are swallowed; the loop is itself the retry.

## Caller-supplied payment IDs

```ts
import { generatePaymentId } from '@inflowpayai/x402/extensions';

const paymentId = generatePaymentId(); // 'pay_<32 hex>'
const prepared = await core.prepareInflowPayment(requirement, context, { paymentId });
```

The ID is forwarded to the server's `remotePaymentId` field and embedded in the resulting `PaymentPayload.extensions['payment-identifier']`.
Invalid format (16–128 chars, `^[a-zA-Z0-9_-]+$`) throws `X402PaymentIdFormatError` before any server round trip. The one-shot
`createPaymentPayload` path doesn't carry a per-call `paymentId` — use `prepareInflowPayment` when a custom ID is required.

## See also

- [@inflowpayai/x402](../x402) — protocol types and HTTP client
- [Product overview](../../docs/x402/README.md)
- [Architecture](../../docs/x402/architecture.md) — buyer-side composition, request lifecycle, conflict precedence
- [Extensions](../../docs/x402/extensions.md) — `payment-identifier` end-to-end

## License

MIT.
