# Architecture

How InFlow's `@inflowpayai/mpp*` packages compose with the [`mppx`](https://github.com/wevm/mppx) foundation SDK to
deliver an MPP integration, and where that diverges from the generic `mppx` custom-method examples.

## Central decision: InFlow is the PSP

The InFlow server owns balance/instrument provisioning, validation, and settlement. `GET /v1/mpp/config` advertises each
currency's rail capability (`currencyRails`). The **seller issues challenges locally**; the server does not mint them.
During the credential lifecycle it correlates by the server-stamped `transactionId` carried in the payload.

- The **seller** package's `Method.toServer` methods issue and render `WWW-Authenticate` challenges locally. `validate`
  forwards the credential to non-mutating `POST /v1/mpp/validate`; `broadcast` calls authoritative
  `POST /v1/mpp/broadcast`, where the server revalidates, claims replay state, settles, and returns a `Receipt` (or a
  problem). `mppx` composes these into its compatibility `verify` hook. This is the direct analog of x402-seller
  delegating validation/settlement to the InFlow facilitator. For the `inflow` method, a single charge advertises one
  currency; to offer several, the seller emits one challenge per currency via `compose(...)` — surfaced by the package's
  `inflowCharges` helper, the MPP analog of x402-seller's `inflowAccepts`.
- The **buyer** package's `Method.toClient.createCredential` methods do not sign locally. They forward the parsed
  challenge to `POST /v1/transactions/mpp`, poll `GET /v1/transactions/{id}/mpp` through the `pending → ready`
  lifecycle, and return the server-produced credential, re-serialised for the `Authorization: Payment` header.

This is the exact analog of the x402 facilitator boundary documented in
[../x402/architecture.md](../x402/architecture.md).

## Package layering

```
              @inflowpayai/mpp  (core: Method defs, types, codec, MppClient)
              /                 \
             /                   \
  @inflowpayai/mpp-seller    @inflowpayai/mpp-buyer
   (Method.toServer +          (Method.toClient +
    validate/broadcast)         transaction driver)
```

The core package holds the **shared `Method.from` definition and the request primitives** both sides call. It depends
only on `mppx` (peer). It contains no challenge-issuance orchestration and no polling loop — those live in the side
packages. The side packages re-export `Mppx` from the appropriate `mppx` entry so consumers get one import, and depend
on the `mppx` framework middleware directly rather than re-wrapping it.

## What the core `MppClient` covers

`MppClient` wraps the shared `InflowHttpClient` transport (API-key, Bearer, or anonymous auth; retry on 429/502/503/504
with capped backoff; per-request timeout; JSON parsing; `InflowApiError` mapping — identical in shape to the x402 core
client) and exposes one method per route:

| Route                            | Method                            | Side   |
| -------------------------------- | --------------------------------- | ------ |
| `GET  /v1/mpp/config`            | `getConfig`                       | seller |
| `POST /v1/mpp/validate`          | `validate`                        | seller |
| `POST /v1/mpp/broadcast`         | `broadcast`                       | seller |
| `POST /v1/transactions/mpp`      | `createTransaction`               | buyer  |
| `GET  /v1/transactions/{id}/mpp` | `getTransaction`                  | buyer  |

(There is no public `POST /v1/mpp/challenges` surface — the seller issues challenges locally, so the core client exposes
no challenge-minting call.)

`validate` never claims replay state, consumes an authorization, broadcasts a transaction, or settles funds. A
successful validation only means the credential is acceptable at that instant; it does not prove that a later broadcast
will settle, nor distinguish an authorization whose payment already settled. `broadcast` is the delivery authority: it
revalidates and then returns the terminal receipt or problem. Broadcast reports success versus failure in the body
(`receipt`/`receiptHeader` versus `problem`), so callers branch on the result rather than catching.

When supported by the server, the seller SDK generates a fresh HTTP idempotency key for each broadcast invocation.
Transport retries within that invocation reuse the key and can recover the original response, while a separate use of
the same credential receives a different key and reaches the server's replay or authorization guard.

## Buyer poll lifecycle

`POST /v1/transactions/mpp` may return `pending` (e.g. when the method requires buyer approval). The buyer then polls
`GET /v1/transactions/{id}/mpp` until it flips to `ready` (credential available), `failed`, or `expired`. This is the
direct analog of the x402-buyer `prepare → poll → auto-cancel` lifecycle: orphan transactions are bounded by server-side
expiry. Drive cadence from the server-advertised `retryAfterSeconds` (per poll) and the challenge TTL from config rather
than hard-coded values.

```
buyer                         InFlow server
  │  POST /v1/transactions/mpp     │
  │ ─────────────────────────────▶│  state = pending, retryAfterSeconds = N
  │ ◀─────────────────────────────│
  │  (wait N seconds)              │
  │  GET /v1/transactions/{id}/mpp │
  │ ─────────────────────────────▶│  state = ready, credential = <b64url>
  │ ◀─────────────────────────────│
  │  Authorization: Payment <b64url>  (forwarded verbatim — see protocol-mapping.md)
```
