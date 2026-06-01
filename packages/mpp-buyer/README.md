# @inflowpayai/mpp-buyer

Buyer-side of InFlow's MPP (Machine Payments Protocol) method for the
[InFlow MPP SDK](https://github.com/inflowpayai/inflow-node/tree/main/docs/mpp). It attaches `Method.toClient` behaviour
to the shared `inflow` method from
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

## Usage

### Transparent (polyfilled global `fetch`)

`Mppx.create` polyfills `globalThis.fetch` by default, so payments happen transparently on a `402`:

```ts
import { Mppx, inflow } from '@inflowpayai/mpp-buyer';

Mppx.create({ methods: [inflow({ apiKey, environment: 'sandbox' })] });

const res = await fetch('https://api.example.com/widgets');
// 402 → InFlow fulfils the challenge → request is replayed with `Authorization: Payment …`
```

### Manual / non-polyfill

```ts
import { Mppx, inflow, Receipt } from '@inflowpayai/mpp-buyer';

const mppx = Mppx.create({ polyfill: false, methods: [inflow({ apiKey, environment: 'sandbox' })] });

// For an instrument-rail (fiat) challenge, pass the funding instrument via per-request context.
const res = await mppx.fetch('https://api.example.com/widgets', {
  context: { instrumentId: '00000000-0000-0000-0000-000000000001' },
});

const receipt = Receipt.fromResponse(res); // present when the seller returned a `Payment-Receipt`
```

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

## Errors

`MppPaymentFailedError` (carries the server's `MppProblemDetail`), `MppPaymentExpiredError`, `MppPaymentTimeoutError`,
`MppPaymentCancelledError`, and `MppMalformedCredentialError`.

## License

MIT
