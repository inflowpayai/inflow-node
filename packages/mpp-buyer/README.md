# @inflowpayai/mpp-buyer

Buyer-side of InFlow's MPP (Machine Payments Protocol) `inflow` method for [`mppx`](https://github.com/wevm/mppx). It
attaches `Method.toClient` behaviour to the shared `inflow` method from
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

## What's exported

- `inflow(parameters)` — the buyer `inflow` client method. Pass it to `Mppx.create({ methods: [inflow({ apiKey })] })`.
  The returned method is augmented with `cleanup()` (aborts any in-flight poll) and `cancelApproval(approvalId)`
  (fire-and-forget cancel of a backing approval, e.g. for out-of-process resumption).
- `inflowContextSchema` — the per-call context schema (`{ instrumentId? }`) `mppx` validates before `createCredential`
  runs.
- `Mppx` (re-exported from `mppx/client`) and `Receipt` (from `mppx`) — a single import gives the foundation client and
  the InFlow method.
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

- [@inflowpayai/mpp](../mpp) — core `inflow` `Method` definition, wire types, codec, HTTP client
- [Product overview](../../docs/mpp/README.md)
- [Architecture](../../docs/mpp/architecture.md) — InFlow-as-PSP boundary, package layering, the buyer poll lifecycle
- Examples: [`mpp-buyer-fetch`](../../examples/mpp-buyer-fetch) (transparent),
  [`mpp-buyer-manual`](../../examples/mpp-buyer-manual) (explicit `mppx.fetch`)

## License

MIT
