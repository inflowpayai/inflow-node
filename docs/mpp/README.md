# InFlow MPP SDK

InFlow's Node.js SDK for the [Machine Payments Protocol (MPP)](https://mpp.dev) — the IETF "Payment" HTTP authentication
scheme ([paymentauth.org](https://paymentauth.org)). A seller answers `402 Payment Required` with one or more
`WWW-Authenticate: Payment …` challenge headers; the buyer pays and resubmits an `Authorization: Payment <credential>`
header; the seller verifies and returns a `Payment-Receipt`.

InFlow is the **PSP (payment service provider)**: it validates payment credentials and processes settlement. The seller
issues the challenge locally — there is no server round-trip to mint one. These packages talk to InFlow's REST
endpoints; they do not re-implement the protocol engine. This mirrors the [x402 product](../x402/README.md),
substituting the MPP wire protocol for x402's.

## Packages

| Package                                  | Role                                                           | Install when…                       |
| ---------------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| [`@inflowpayai/mpp`](../../packages/mpp) | Core: MPP `Method` definitions, wire types, codec, HTTP client | Rarely installed directly.          |
| `@inflowpayai/mpp-seller`                | `Method.toServer` + InFlow redeem/settle driver                | Accepting MPP payments as a seller. |
| `@inflowpayai/mpp-buyer`                 | `Method.toClient` + InFlow buyer-endpoint driver               | Paying via MPP.                     |

All packages publish under the `@inflowpayai` scope and declare [`mppx`](https://github.com/wevm/mppx)`@^0.8.17` as a
peer. The seller/buyer packages additionally re-export `Mppx` from the appropriate `mppx` entry (`mppx/server` /
`mppx/client`) so consumers get a single import.

## Seller Prerequisite

Create an InFlow **Seller** account and API key in the environment you will use: [sandbox](https://sandbox.inflowpay.ai)
for testing or [production](https://app.inflowpay.ai) for live payments. A Developer account does not authorize Seller
configuration or settlement endpoints. The server returns `SELLER_ACCOUNT_REQUIRED` in its structured error response
when a valid credential belongs to the wrong account type.

## Buyer Authentication

The InFlow buyer methods require an authenticated InFlow account. For a buyer-only API-key integration, create a
Developer account. If the application already has a Seller account, reuse it; Seller accounts can buy. Create the
account and credential in [sandbox](https://sandbox.inflowpay.ai) for testing or [production](https://app.inflowpay.ai)
for live payments, then pass the matching `environment` to the SDK.

## The core package

`@inflowpayai/mpp` is the shared foundation both side packages import. It carries no client- or server-only
orchestration. It exports:

- **`inflow`** — the `mppx` `Method` definition for InFlow balance/instrument payments, organised as a namespace that
  defaults to `charge` (`inflow` and `inflow.charge` are the same definition; see [extensions.md](./extensions.md)).
- **`tempo`** — the `mppx` `Method` definition for Tempo TIP-20 charges (`tempo` and `tempo.charge` are the same
  definition). The buyer/seller packages attach `Method.toClient` / `Method.toServer` behaviour to both methods.
- **`cardCharge`** — the USD/Visa CARD definition. The seller package loads the merchant configuration; the buyer
  package requests an encrypted purchase credential using a linked Visa card and its VIC allowance.
- **Wire types** — `MppChallenge`, `MppCredential`, `MppReceipt`, `MppProblemDetail`, and the InFlow REST DTOs
  (`MppConfigResponse`, `MppCredentialRequest`, `MppValidateRequest/Response`, `MppBroadcastRequest/Response`,
  `MppTransactionRequest/Response`). These match the MPP wire format byte-for-byte.
- **Codec** — RFC 8785 JCS + base64url-without-padding `encode`/`decode` for `request`/`opaque`/`credential`/`receipt`,
  plus `renderChallengeHeader` / `parseChallengeHeader(s)` for the `WWW-Authenticate: Payment` grammar.
- **`MppClient`** — a thin typed client over the InFlow MPP REST endpoints (`/v1/mpp/config`, `/v1/mpp/validate`,
  `/v1/mpp/broadcast`, `/v1/transactions/mpp`, `/v1/transactions/{id}/mpp`), with `Idempotency-Key` support on seller
  broadcast. Buyer transaction creation is not automatically retried.
- **Constants and typed errors** — header names, scheme/method/intent labels, problem-type URIs; `InflowApiError`,
  `MppCodecError`, `MppProtocolVersionError`.

See the [core client example](../../packages/mpp/README.md#example) for parsing a real challenge and retaining the
transaction ID, and [payment status](../../packages/mpp/README.md#card-verification-and-payment-status) for bank
verification and settlement recovery.

## Choose a card payment method

Sellers connect Stripe through their InFlow Seller dashboard and explicitly enable the methods they want to offer in
their application. The SDK uses an InFlow API key, not a Stripe secret key.

| Seller offer           | Buyer requirements                                                                                          | Buyer SDK                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `inflow/charge` in USD | InFlow account with a linked card; no VIC allowance or USD wallet balance                                   | [`inflow`](../../packages/mpp-buyer/README.md#pay-with-a-linked-card)                                                    |
| `card/charge`          | Encrypted Visa network-token credential; InFlow buyers need a linked Visa card and a verified VIC allowance | [`card`](../../packages/mpp-buyer/README.md#pay-a-card-offer-with-a-vic-allowance), or a compatible external CARD client |
| `stripe/charge`        | Stripe Shared Payment Token, such as one obtained through Stripe Link                                       | A compatible Stripe buyer; this buyer package does not obtain Shared Payment Tokens                                      |

For x402, ordinary linked-card payments use the separate
[`instrument` scheme](../../packages/x402-seller/README.md#linked-card-payments). MPP CARD credentials and Stripe Shared
Payment Tokens are not x402 Instrument payloads.

## Quickstart — seller

The seller package (`@inflowpayai/mpp-seller`) attaches non-mutating validation and authoritative broadcast behavior to
`Method.toServer`: an unpaid request returns a locally issued `402` challenge, and a paid one is validated and settled
through InFlow. It exports seller methods for `inflow`, `tempo`, `card`, and one-time Stripe charges.
`await stripe(...)` reads the authenticated seller's Stripe profile capability from InFlow. Sellers link their Stripe
account through Stripe Connect in the InFlow dashboard; the SDK uses an InFlow API key, and InFlow handles Stripe
settlement with its platform credentials and the seller's connected-account ID. To accept **multiple InFlow currencies**
on one route (one challenge per currency), use the package's `inflowCharges` / `inflowChargesNodeListener` helpers over
the core `mppx/server` instance — the framework adapters expose only the single-currency `charge`. See
[architecture.md](./architecture.md) for the PSP boundary, and
[`examples/mpp-seller-express`](../../examples/mpp-seller-express) or
[`examples/mpp-seller-hono`](../../examples/mpp-seller-hono) for the complete runnable shape.

## Quickstart — buyer

The buyer package (`@inflowpayai/mpp-buyer`) provides `Method.toClient` behaviour for `inflow`, `tempo`, and `card`. Its
`createCredential` forwards the parsed challenge to `POST /v1/transactions/mpp`, polls `GET /v1/transactions/{id}/mpp`
through the `pending → ready` lifecycle, and returns the server-produced credential without inventing or rewriting its
fields. See [`examples/mpp-buyer-fetch`](../../examples/mpp-buyer-fetch) (transparent, polyfilled `fetch`) and
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
