# @inflowpayai/mpp-buyer

Buyer-side of InFlow's MPP (Machine Payments Protocol) methods for [`mppx`](https://github.com/wevm/mppx). It attaches
`Method.toClient` behaviour to shared methods from
[`@inflowpayai/mpp`](https://github.com/inflowpayai/inflow-node/tree/main/packages/mpp): `createCredential` does **not**
sign locally — it drives the InFlow buyer endpoints (`POST /v1/transactions/mpp` → poll `GET /v1/transactions/{id}/mpp`)
through the pending → ready lifecycle and returns the **server-produced** credential. This is the MPP analog of
`@inflowpayai/x402-buyer`'s `InflowClient`.

## Install

```bash
pnpm add @inflowpayai/mpp-buyer mppx
```

[`mppx`](https://github.com/wevm/mppx) is a peer dependency — co-install it so package managers warn loudly when it's
missing. `@inflowpayai/mpp` comes along as a normal dependency.

## InFlow Account

This package calls authenticated buyer transaction endpoints. For a buyer-only API-key integration, create a Developer
account. If the application already has a Seller account, reuse it; Seller accounts can buy. Create the account and
credential in [sandbox](https://sandbox.inflowpay.ai) for testing or [production](https://app.inflowpay.ai) for live
payments, then pass the matching `environment`. Supply either `apiKey` or a `getAccessToken` callback; the two
authentication forms are mutually exclusive.

## What's exported

- `inflow(parameters)` — the buyer `inflow` client method. Pass it to `Mppx.create({ methods: [inflow({ apiKey })] })`.
  The returned method is augmented with `cleanup()` (aborts any in-flight poll) and `cancelApproval(approvalId)`
  (fire-and-forget cancel of a backing approval, e.g. for out-of-process resumption).
- `tempo(parameters)` — the buyer `tempo` client method. It uses the same InFlow buyer endpoints and returns the
  server-produced Tempo credential.
- `card(parameters)` — the buyer `card/charge` method for Visa payments using a linked card and its VIC allowance. It
  supports `cleanup()` and `cancelApproval(approvalId)` like the other buyer methods.
- `cardContextSchema` and `CardPaymentOptions` — required merchant name, website URL and country code, with an optional
  instrument ID.
- `inflowContextSchema` — the per-call context schema (`{ instrumentId? }`) `mppx` validates before `createCredential`
  runs.
- `tempoContextSchema` — the empty per-call context schema for Tempo charges.
- `Mppx` (re-exported from `mppx/client`) and `Receipt` (from `mppx`) — a single import gives the foundation client and
  the InFlow methods.
- `McpClient` from the optional `@inflowpayai/mpp-buyer/mcp` entrypoint — wraps an MCP SDK client in place so existing
  references handle payment-required tool results and errors. Install `@modelcontextprotocol/sdk` when using it.
- `Discovery` (from `mppx/discovery`) — parses canonical `x-payment-info.offers[]` metadata and normalizes the legacy
  flat discovery shape to a one-element offer array. Runtime `402` challenges remain authoritative.
- Types: `InflowBuyerParameters`, `FulfilOptions`, plus the core re-exports `Environment`, `InflowClientOptions` /
  `InflowAnonymousClientOptions` / `InflowBearerClientOptions`, `InflowPaymentOptions`, `MppCredential`.
- Errors: `MppPaymentFailedError` (carries the server's `MppProblemDetail`), `MppPaymentExpiredError`,
  `MppPaymentTimeoutError`, `MppPaymentCancelledError`, `MppMalformedCredentialError`.

## Quickstart

`Mppx.create` polyfills `globalThis.fetch` by default, so payments happen transparently on a `402`:

```ts
import { Mppx, inflow } from '@inflowpayai/mpp-buyer';

Mppx.create({ methods: [inflow({ apiKey, environment: 'sandbox' })] });

const res = await fetch('https://api.example.com/widgets');
// 402 → InFlow fulfils the challenge → request is replayed with `Authorization: Payment …`
```

For MCP tools, install the optional SDK and use the same InFlow method with the foundation wrapper:

```bash
pnpm add @inflowpayai/mpp-buyer mppx @modelcontextprotocol/sdk
```

The wrapper modifies and returns the original MCP client. Free tools pass through normally. For a paid tool, it handles
the payment challenge and retries the tool call with the resulting credential. `onPaymentRequired` receives the selected
challenge: return `true` to continue or `false` to reject the payment. If the hook is omitted, compatible payments
proceed automatically, so provide it unless automatic payment is intentional.

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { inflow } from '@inflowpayai/mpp-buyer';
import { McpClient } from '@inflowpayai/mpp-buyer/mcp';

const client = new Client({ name: 'buyer', version: '1.0.0' });
await client.connect(transport);

McpClient.wrap(client, {
  methods: [inflow({ apiKey, environment: 'sandbox' })],
  onPaymentRequired: async (challenge) => approve(challenge),
});

const result = await client.callTool({ name: 'paid-tool', arguments: {} });
console.log(result.content, result.receipt);
```

For an instrument-rail challenge, pass the buyer-selected instrument as per-call context:

```ts
await client.callTool({ name: 'paid-tool', arguments: {} }, undefined, { context: { instrumentId } });
```

The transparent path above is [`examples/mpp-buyer-fetch`](../../examples/mpp-buyer-fetch); the explicit, non-polyfill
path (`Mppx.create({ polyfill: false })` + `mppx.fetch`) is
[`examples/mpp-buyer-manual`](../../examples/mpp-buyer-manual).

The rail (`balance` for crypto, `instrument` for fiat) is **derived from the seller's challenge** — the buyer does not
choose it. For the `inflow` method, the only buyer-supplied per-call option is `instrumentId` for instrument-rail
challenges.

## Pay with a linked card

An `inflow/charge` offer in USD uses an ordinary card linked to your InFlow account. It does not require a VIC allowance
or a USD wallet balance. Link a card in the matching sandbox or production dashboard before paying. Omitting the
Instrument ID uses your primary card; selecting an unavailable card fails rather than falling back to another card.

For an HTTP request, pass the selection in the buyer's per-call context:

```ts
import { Mppx, inflow } from '@inflowpayai/mpp-buyer';

const buyer = Mppx.create({
  maxPaymentRetries: 1,
  polyfill: false,
  methods: [inflow({ apiKey: process.env['INFLOW_API_KEY'] ?? '', environment: 'sandbox' })],
});
const instrumentId = process.env['INSTRUMENT_ID'];
const response = await buyer.fetch('http://localhost:3000/api/report', {
  context: instrumentId === undefined ? {} : { instrumentId },
});
console.log(response.status);
```

The selection goes to the InFlow buyer endpoint, not the seller. The seller's challenge supplies the price and rail; the
buyer does not substitute a different currency or switch to balance funding after a failure.

InFlow approval and bank verification are distinct steps. Credential creation waits for InFlow approval; it does not
wait for the seller's subsequent settlement or open a bank verification page. A pending settlement response or lost
connection must not trigger a fresh `buyer.fetch` purchase. Applications that handle recovery should retain the original
transaction ID and credential using [`MppClient`](../mpp/README.md#card-verification-and-payment-status), inspect
`getPaymentStatus`, and replay the same credential after settlement. The high-level method does not retain that recovery
state for the application.

Run the [manual buyer example](../../examples/mpp-buyer-manual#pay-the-usd-linked-card-example) against the USD-only
seller example to exercise a USD 1.00 purchase.

## Pay a CARD offer with a VIC allowance

Use `card` when the seller advertises `card/charge`. Link a Visa card in your InFlow dashboard and create and verify its
VIC allowance before paying. This method supports USD charges of at least USD 0.50; unlike ordinary `inflow` instrument
payments, it requires an allowance. The seller can use InFlow or another CARD-compatible processor integration.

Provide the merchant's business name, absolute HTTP or HTTPS website URL, and two-letter country code for every payment.
These describe the seller, not the buyer's billing address. Obtain them from the seller; the SDK does not guess or ask
interactive questions. InFlow uses verified Seller details instead when it recognizes an InFlow seller. Omitting
`instrumentId` selects your primary card; an invalid selection does not fall back to a different card.

```ts
import { card, Mppx } from '@inflowpayai/mpp-buyer';

const method = card({ apiKey: process.env['INFLOW_API_KEY'] ?? '', environment: 'sandbox' });
const buyer = Mppx.create({ methods: [method], polyfill: false, maxPaymentRetries: 1 });
try {
  const response = await buyer.fetch('https://seller.example/report', {
    context: {
      merchant: { name: 'Example Seller', url: 'https://seller.example', countryCode: 'US' },
      // instrumentId: '00000000-0000-4000-8000-000000000001',
    },
  });
  console.log(response.status);
} finally {
  method.cleanup();
}
```

`maxPaymentRetries: 1` permits one credential-backed request after the initial 402. A further 402 is returned to your
application rather than starting another purchase. Do not automatically repeat `buyer.fetch` after an error, timeout, or
uncertain response. For resumable applications, use the core `MppClient` transaction methods, retain the transaction ID
and request, and recover the saved credential with `getTransaction(transactionId)`. Replay that credential for the same
purchase instead of calling `createTransaction` again. Treat stored credentials as secrets.

The method waits for InFlow approval, then polls for the encrypted purchase credential. It neither decrypts card data
nor holds Basis Theory or Stripe keys. `ready` means the credential is available, not that the seller has charged the
card. An issuance failure raises `MppPaymentFailedError` with the server's explanation and `transactionId` when
supplied. An unknown issuance outcome requires support or reconciliation, not a replacement payment.

To check server availability, call `MppClient.getSupported()` and look for method `card` with intent `charge`. CARD has
no InFlow settlement rail, so its `rails` list is empty; it is not the `inflow` method's `instrument` rail. That
capability does not establish that a particular buyer has a usable card or allowance.

Cancelling a pending approval can stop issuance. Once approval has completed, `cleanup()` only stops the local wait; it
does not revoke an issued credential or reverse a payment.

## Lifecycle, cancellation, and orphans

`POST /v1/transactions/mpp` returns `ready` (credential available) for synchronous methods, or `pending` when the payer
must approve out-of-band. On `pending` the SDK polls `GET /v1/transactions/{id}/mpp`, driving cadence from the
server-advertised `retryAfterSeconds` (default 5 s) and bounding the total wait by `timeoutMs` (default 15 min).

A `pending` transaction is backed by a server-side **approval**. The method instance carries:

- **`cleanup()`** — aborts in-flight transaction creation, polling, and existing-subscription authorization requests.
  The awaiting `createCredential` rejects with `MppPaymentCancelledError`, and a known backing approval is cancelled
  fire-and-forget. Cleanup does not cancel the subscription itself. The method remains usable for subsequent calls.
- **`cancelApproval(approvalId)`** — a standalone fire-and-forget cancel (for out-of-process resumption, e.g. a CLI). It
  never rejects on a server-side outcome (already-terminal approval, not found, …).

If a cancel is unavailable or races, **server-side expiry is the backstop** — orphaned pending transactions are reaped
when their challenge/approval window elapses.

The pending timeout includes polling requests as well as delays between polls. It starts after transaction creation
returns; it is separate from the HTTP client's per-request timeout.

## See also

- [@inflowpayai/mpp](../mpp) — core MPP `Method` definitions, wire types, codec, HTTP client
- [Product overview](../../docs/mpp/README.md)
- [Architecture](../../docs/mpp/architecture.md) — InFlow-as-PSP boundary, package layering, the buyer poll lifecycle
- Examples: [`mpp-buyer-fetch`](../../examples/mpp-buyer-fetch) (transparent),
  [`mpp-buyer-manual`](../../examples/mpp-buyer-manual) (explicit `mppx.fetch`)

## License

MIT
