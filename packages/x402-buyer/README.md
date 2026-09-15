# @inflowpayai/x402-buyer

Buyer-side InFlow primitives that plug into the foundation V2 buyer transport (`x402HTTPClient` from `@x402/core`). This
package ships **`InflowClient`** — a subclass of `@x402/core`'s `x402Client` that routes InFlow-acceptable
`(scheme, network)` pairs through the InFlow MPC signing flow and delegates everything else to foundation-managed
schemes registered on the same instance.

## Install

```bash
pnpm add @inflowpayai/x402-buyer @x402/core
# …add @x402/evm or @x402/svm as needed for on-chain signing
```

`@inflowpayai/x402` is a runtime dependency (bundled via workspace); `@x402/core` is a peer dependency.

## InFlow Account

This package calls authenticated buyer transaction endpoints. For a buyer-only API-key integration, create a Developer
account. If the application already has a Seller account, reuse it; Seller accounts can buy. Create the account and
credential in [sandbox](https://sandbox.inflowpay.ai) for testing or [production](https://app.inflowpay.ai) for live
payments, then pass the matching `environment`. Supply either `apiKey` or a `getAccessToken` callback; the two
authentication forms are mutually exclusive.

The optional external-wallet extension below calls a public preparation endpoint and needs no InFlow account or API key.

## What's exported

- `createInflowClient(options)` — async factory. Returns a primed `InflowClient`. Primes the buyer capability cache
  before resolving, so the routing decision inside `createPaymentPayload` is synchronous against in-memory data.
- `InflowClient` — `extends @x402/core/client.x402Client`. Overrides `createPaymentPayload` to route to InFlow first and
  fall back to foundation-registered schemes. Adds `prepareInflowPayment` for callers that want to surface
  pending-approval UI before the protected request is replayed.
- `parseEvmPrivateKey`, `decodeSolanaSecret` — key-decoding helpers for callers wiring up foundation EVM/SVM schemes
  from existing InFlow-managed wallet exports.
- Typed errors: `X402AdapterRoutingError`, `X402ApprovalCancelledError`, `X402ApprovalFailedError`,
  `X402ApprovalTimeoutError`, `X402PaymentIdFormatError`, `X402InvalidEvmKeyError`, `X402InvalidSolanaKeyError`.

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

The same composition works with axios — see [`examples/x402-buyer-axios`](../../examples/x402-buyer-axios) for the
variant that swaps `fetch` for an axios call and decodes the response header with `decodePaymentResponseHeader` from
`@x402/core/http`.

## Composing with foundation schemes

Permit2 payments always use an external wallet registered with the foundation scheme. They are excluded from InFlow's
managed signing path, including `prepareInflowPayment`. For EIP-2612 sponsorship, use foundation `@x402/evm` 2.22.0 or
later and supply the network's `schemeOptions.rpcUrl` for nonce and allowance reads. The seller must declare sponsorship
for a compatible token; the foundation signs an exact-amount permit when allowance is insufficient.

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

When the seller's 402 offers a requirement InFlow signs (`balance/inflow:1`, or any `(scheme, network)` advertised by
the buyer capability cache), the InFlow path wins. Otherwise the foundation's selector routes to whatever EVM or SVM
scheme the caller registered. The foundation methods (`register`, `registerPolicy`, `onBeforePaymentCreation`, …) are
return-type narrowed to `this` so chaining preserves the `InflowClient` type.

## EIP-7702 sponsorship for external wallets

For tokens without EIP-2612, register the optional extension alongside the foundation EVM scheme. Install `@x402/evm`
2.22.0 or later and `viem` 2.56.3 or later. Ordinary buyer imports do not load these optional dependencies.

```ts
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { createInflowEip7702GasSponsoringExtension } from '@inflowpayai/x402-buyer/eip7702';
import type { InflowEip7702Signer } from '@inflowpayai/x402-buyer/eip7702';

function externalBuyer(
  signer: InflowEip7702Signer & Parameters<typeof registerExactEvmScheme>[1]['signer'],
  consentToDelegation: Parameters<typeof createInflowEip7702GasSponsoringExtension>[0]['consentToDelegation'],
) {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer, networks: ['eip155:84532'] });
  client.registerExtension(
    createInflowEip7702GasSponsoringExtension({
      environment: 'sandbox',
      signer,
      consentToDelegation,
    }),
  );
  return client;
}
```

Supply your external owner's signing callbacks and a `readContract` implementation for the selected chain. The consent
callback must show the chain and delegation address to the owner and return true only after approval. It is called when
delegation is needed, before `signAuthorization`. Wallets that cannot authorize this specific delegation cannot use this
extension.

With `@x402/core` 2.25.0 or later, use `x402Client.fromConfig` to explicitly allow non-default tokens through
`spendControls.allowedAssets`, specifying the network, token address and an atomic `maxAmountPerPayment` cap.
Sponsorship does not bypass the foundation client's spending controls.

The seller must declare `inflowEip7702GasSponsoring`. When allowance is insufficient, the extension calls the configured
InFlow environment's `/v1/x402/eip7702/prepare`, validates the exact approval-and-payment batch and operation hash, then
collects the owner's signatures. It never broadcasts. The facilitator submits the prepared operation at settlement. The
extension uses EntryPoint 0.7 and SemiModularAccount7702 v1.1.0 at `0x77021100bD87b7008E5E1989d0eB38555d0d0000`. It does
not support installed execution hooks or alternative nonce keys. Preparation errors and wallet rejections stop the
payment; they do not select another funding source.

Delegation is persistent: it can remain installed even if payment execution fails. EIP-7702 authorization has no
deadline; the preparation expiry does not revoke it. Only the token approval and payment calls are atomic. Existing
delegations must be compatible with the pinned implementation. This is a custom InFlow protocol, not the standard
`erc20ApprovalGasSponsoring` raw-transaction extension. Managed InFlow buyers remain excluded from Permit2 signing.

## Two-phase signing (pending-approval UI)

For callers that want to surface a pending-approval state to the user before the protected request is replayed,
`prepareInflowPayment` returns a `PreparedPayment` handle:

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

The two-phase flow is InFlow-specific — there's no foundation equivalent. `prepareInflowPayment` throws
`X402AdapterRoutingError` if the requirement is not in the InFlow buyer capability cache.

## Signing timeouts

`SignOptions.timeoutMs` defaults to **15 minutes** to match the server-side approval expiry.
`SignOptions.pollIntervalMs` defaults to **5 seconds** — caller-overridable, no jitter or backoff. Transient 5xx errors
during a single poll are swallowed; the loop is itself the retry.

## Caller-supplied payment IDs

```ts
import { generatePaymentId } from '@inflowpayai/x402/extensions';

const paymentId = generatePaymentId(); // 'pay_<32 hex>'
const prepared = await core.prepareInflowPayment(requirement, context, { paymentId });
```

The ID is forwarded to the server's `remotePaymentId` field and embedded in the resulting
`PaymentPayload.extensions['payment-identifier']`. Invalid format (16–128 chars, `^[a-zA-Z0-9_-]+$`) throws
`X402PaymentIdFormatError` before any server round trip. The one-shot `createPaymentPayload` path doesn't carry a
per-call `paymentId` — use `prepareInflowPayment` when a custom ID is required.

## See also

- [@inflowpayai/x402](../x402) — protocol types and HTTP client
- [Product overview](../../docs/x402/README.md)
- [Architecture](../../docs/x402/architecture.md) — buyer-side composition, request lifecycle, conflict precedence
- [Extensions](../../docs/x402/extensions.md) — `payment-identifier` end-to-end

## License

MIT.
