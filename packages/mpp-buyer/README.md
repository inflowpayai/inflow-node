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
choose it. The only buyer-supplied per-call option is `instrumentId` for instrument-rail challenges.

## Lifecycle, cancellation, and orphans

`POST /v1/transactions/mpp` returns `ready` (credential available) for synchronous methods, or `pending` when the payer
must approve out-of-band. On `pending` the SDK polls `GET /v1/transactions/{id}/mpp`, driving cadence from the
server-advertised `retryAfterSeconds` (default 5 s) and bounding the total wait by `timeoutMs` (default 15 min).

A `pending` transaction is backed by a server-side **approval**. The method instance carries:

- **`cleanup()`** — aborts any in-flight poll. The awaiting `createCredential` rejects with `MppPaymentCancelledError`,
  and the backing approval is cancelled fire-and-forget.
- **`cancelApproval(approvalId)`** — a standalone fire-and-forget cancel (for out-of-process resumption, e.g. a CLI). It
  never rejects on a server-side outcome (already-terminal approval, not found, …).

If a cancel is unavailable or races, **server-side expiry is the backstop** — orphaned pending transactions are reaped
when their challenge/approval window elapses.

## See also

- [@inflowpayai/mpp](../mpp) — core MPP `Method` definitions, wire types, codec, HTTP client
- [Product overview](../../docs/mpp/README.md)
- [Architecture](../../docs/mpp/architecture.md) — InFlow-as-PSP boundary, package layering, the buyer poll lifecycle
- Examples: [`mpp-buyer-fetch`](../../examples/mpp-buyer-fetch) (transparent),
  [`mpp-buyer-manual`](../../examples/mpp-buyer-manual) (explicit `mppx.fetch`)

## License

MIT
