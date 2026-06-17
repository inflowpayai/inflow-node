# InFlow MPP SDK

InFlow's Node.js SDK for the [Machine Payments Protocol (MPP)](https://mpp.dev) — the IETF "Payment" HTTP authentication
scheme ([paymentauth.org](https://paymentauth.org)). A seller answers `402 Payment Required` with one or more
`WWW-Authenticate: Payment …` challenge headers; the buyer pays and resubmits an `Authorization: Payment <credential>`
header; the seller verifies and returns a `Payment-Receipt`.

InFlow is the **PSP (payment service provider)**: it redeems credentials and settles. The seller issues the challenge
locally — there is no server round-trip to mint one — and InFlow correlates the redemption by the transaction id carried
in the credential and settles. These packages are SDK glue that talks to InFlow's REST endpoints; they do not
re-implement the protocol engine. This mirrors the [x402 product](../x402/README.md), substituting the MPP wire protocol
for x402's.

## Packages

| Package                                  | Role                                                           | Install when…                       |
| ---------------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| [`@inflowpayai/mpp`](../../packages/mpp) | Core: MPP `Method` definitions, wire types, codec, HTTP client | Rarely installed directly.          |
| `@inflowpayai/mpp-seller`                | `Method.toServer` + InFlow redeem/settle driver                | Accepting MPP payments as a seller. |
| `@inflowpayai/mpp-buyer`                 | `Method.toClient` + InFlow buyer-endpoint driver               | Paying via MPP.                     |

All packages publish under the `@inflowpayai` scope and declare [`mppx`](https://github.com/wevm/mppx)`@^0.6.28` as a
peer. The seller/buyer packages additionally re-export `Mppx` from the appropriate `mppx` entry (`mppx/server` /
`mppx/client`) so consumers get a single import.

## The core package

`@inflowpayai/mpp` is the shared foundation both side packages import. It carries no client- or server-only
orchestration. It exports:

- **`inflow`** — the `mppx` `Method` definition for InFlow balance/instrument payments, organised as a namespace that
  defaults to `charge` (`inflow` and `inflow.charge` are the same definition; see [extensions.md](./extensions.md)).
- **`tempo`** — the `mppx` `Method` definition for Tempo TIP-20 charges (`tempo` and `tempo.charge` are the same
  definition). The buyer/seller packages attach `Method.toClient` / `Method.toServer` behaviour to both methods.
- **Wire types** — `MppChallenge`, `MppCredential`, `MppReceipt`, `MppProblemDetail`, and the InFlow REST DTOs
  (`MppConfigResponse`, `MppRedeemRequest/Response`, `MppTransactionRequest/Response`). These match the MPP wire format
  byte-for-byte.
- **Codec** — RFC 8785 JCS + base64url-without-padding `encode`/`decode` for `request`/`opaque`/`credential`/`receipt`,
  plus `renderChallengeHeader` / `parseChallengeHeader(s)` for the `WWW-Authenticate: Payment` grammar.
- **`MppClient`** — a thin typed client over the InFlow MPP REST endpoints (`/v1/mpp/config`, `/v1/mpp/redeem`,
  `/v1/transactions/mpp`, `/v1/transactions/{id}/mpp`), with `Idempotency-Key` support on the mutating routes.
- **Constants and typed errors** — header names, scheme/method/intent labels, problem-type URIs; `InflowApiError`,
  `MppCodecError`, `MppProtocolVersionError`.

```ts
import { parseChallengeHeaders, MppClient } from '@inflowpayai/mpp';

// Buyer: parse a 402's challenges, then fulfil one via the InFlow buyer endpoint.
const mpp = new MppClient({ apiKey: process.env.INFLOW_API_KEY!, environment: 'sandbox' });
const [challenge] = parseChallengeHeaders(wwwAuthenticateValues);
const tx = await mpp.createTransaction({ challenge });
// `ready` → send `Authorization: Payment ${tx.credential}` on the retried request.
// `pending` → poll `mpp.getTransaction(tx.transactionId!)` until it flips to `ready`.
```

## Quickstart — seller

The seller package (`@inflowpayai/mpp-seller`) attaches `Method.toServer` whose `verify` calls `POST /v1/mpp/redeem`: an
unpaid request returns a locally issued `402` challenge, and a paid one is redeemed and settled through InFlow. It
exports seller methods for `inflow` and `tempo`. To accept **multiple InFlow currencies** on one route (one challenge
per currency), use the package's `inflowCharges` / `inflowChargesNodeListener` helpers over the core `mppx/server`
instance — the framework adapters expose only the single-currency `charge`. See [architecture.md](./architecture.md) for
the PSP boundary, and [`examples/mpp-seller-express`](../../examples/mpp-seller-express) or
[`examples/mpp-seller-hono`](../../examples/mpp-seller-hono) for the complete runnable shape.

## Quickstart — buyer

The buyer package (`@inflowpayai/mpp-buyer`) provides `Method.toClient` behaviour for `inflow` and `tempo`. Its
`createCredential` forwards the parsed challenge to `POST /v1/transactions/mpp`, polls `GET /v1/transactions/{id}/mpp`
through the `pending → ready` lifecycle, and returns the server-produced credential. The buyer does not sign locally and
does not synthesise `source` — the server-produced credential already carries it. See
[`examples/mpp-buyer-fetch`](../../examples/mpp-buyer-fetch) (transparent, polyfilled `fetch`) and
[`examples/mpp-buyer-manual`](../../examples/mpp-buyer-manual) (explicit `mppx.fetch`) for the complete runnable shape.

## Deeper reading

- [architecture.md](./architecture.md) — InFlow-as-PSP boundary, package layering, the buyer poll lifecycle.
- [protocol-mapping.md](./protocol-mapping.md) — InFlow wire models ↔ `mppx` `Method` schemas ↔ IETF drafts.
- [extensions.md](./extensions.md) — the `charge` → `session` namespace path.

Runnable examples live under [`examples/`](../../examples): the `mpp-seller-*` and `mpp-buyer-*` directories. Start a
seller, then run a buyer against it.

For monorepo-level docs (publishing, contributing, tooling), see [../monorepo](../monorepo).

## License

MIT.
