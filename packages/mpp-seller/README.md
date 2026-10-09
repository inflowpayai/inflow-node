# @inflowpayai/mpp-seller

Seller-side InFlow MPP methods for [`mppx`](https://www.npmjs.com/package/mppx). Add them to `Mppx.create`, and
`charge()` returns a `402` payment challenge for unpaid requests, validates credentials without mutation, and settles
them through an authoritative broadcast. This attaches `Method.toServer` behaviour to shared methods from
`@inflowpayai/mpp`; the foundation `mppx` SDK owns the wire mechanics (challenge minting + HMAC binding).

## Install

```sh
pnpm add @inflowpayai/mpp-seller mppx
```

`mppx` is a peer dependency.

## Seller Account

This package requires an InFlow **Seller** account and an API key created in its dashboard:

- [Sandbox registration](https://sandbox.inflowpay.ai) for testing
- [Production registration](https://app.inflowpay.ai) for live payments

`environment` must match the dashboard that issued the key. A Developer account key is valid InFlow authentication but
cannot load Seller configuration. Seller API calls reject with HTTP `403`; the `InflowApiError.body` contains the
server's structured `SELLER_ACCOUNT_REQUIRED` response.

When supported by the server, each broadcast invocation receives a fresh HTTP idempotency key. Its internal transport
retries reuse that key, while a separate credential submission receives a different key and reaches the InFlow server's
authoritative replay or authorization guard.

## What's exported

- `inflow(parameters)` — the seller `inflow` method. Pass it to
  `Mppx.create({ methods: [inflow({ apiKey })], secretKey })`. Its `validate` hook checks the submitted credential
  through InFlow without consuming payment state (`POST /v1/mpp/validate`); `broadcast` revalidates and performs the
  authoritative terminal operation (`POST /v1/mpp/broadcast`). `mppx` coordinates both hooks during payment handling.
- `tempo(parameters)` — the seller `tempo` method for Tempo TIP-20 charges. Pass it to
  `Mppx.create({ methods: [tempo({ apiKey, currency, recipient })], secretKey })`. Fee-payer sponsorship defaults to
  off; set `methodDetails.feePayer: true` (on the method or per charge) to mint a sponsored challenge.
- `await stripe(parameters)` — the seller `stripe/charge` method for one-time USD payments with Stripe Shared Payment
  Tokens. It loads the authenticated seller's verified Stripe business-profile capability from InFlow before returning a
  method. Validation and settlement still use InFlow's `/validate` and `/broadcast` endpoints; no Stripe secret enters
  the application or SDK.
- `await card(parameters)` — the seller `card/charge` method for USD Visa network-token payments. InFlow provides the
  connected Stripe recipient, merchant name and public encryption key, and handles decryption and processing.
- `inflowCharges(mppx, prices)` — present several currencies on one route. Returns the Web-fetch handler from
  `compose(...)`: one `WWW-Authenticate` challenge per price (the MPP analog of `@inflowpayai/x402-seller`'s
  `inflowAccepts`). See [Multiple currencies](#multiple-currencies) below.
- `inflowChargesNodeListener(mppx, prices)` — the same, wrapped with `Mppx.toNodeListener` so it mounts directly on a
  Node `http` server (or an Express route).
- `inflow.subscription(parameters)` — the seller method for recurring InFlow balance payments. Register it on a core
  `mppx/server` instance and present plans with `inflowSubscriptions` or `inflowSubscriptionsNodeListener`.
- `inflowSubscriptions(mppx, plans)` — present one or more recurring plans from a Web Fetch API handler. Each plan is
  advertised as an MPP `inflow/subscription` challenge.
- `inflowSubscriptionsNodeListener(mppx, plans)` — the same subscription handler adapted for Node `http` servers and
  Express routes.
- `createConfigClient(client)` — exposes the `GET /v1/mpp/config` loader directly, to prime or inspect the currency→rail
  capability map yourself. Returns an `InflowConfigClient`.
- `Mppx` and `Expires` (re-exported from `mppx/server`) and `Receipt` (from `mppx`) — a single import gives the
  foundation server handler and the InFlow methods.
- `Discovery` (from `mppx/discovery`) — generates and parses OpenAPI `x-payment-info.offers[]` metadata.
- Types: `CardSellerParameters`, `InflowSellerParameters`, `StripeSellerParameters`, `TempoSellerParameters`,
  `LoadedConfig`, `InflowChargePrice`, plus the core re-exports `Environment`, `MppCurrencyRail`, `MppProblemDetail`,
  `MppReceipt`.
- Errors: `MppUnsupportedCurrencyError` (charge currency has no rail in the PSP config), `MppCredentialProblemError`
  (credential validation or broadcast failed; carries the PSP's RFC 9457 problem), `MppStripeUnavailableError` (seller
  has no safe Stripe capability), and `MppStripeAmountError` (amount is below $0.50, above $999,999.99, or cannot be
  expressed as exact cents). `MppStripeRequestError` identifies unsupported metadata or an `externalId` longer than 255
  characters. Malformed request fields can raise the foundation schema's validation error before these SDK checks.
- `MppCardUnavailableError` means the seller configuration does not advertise the required USD Visa CARD capability.

## Configuration

### HTTP error responses and upstream behavior

Pass `transport: paymentHttpTransport()` to `Mppx.create` for HTTP routes. It uses mppx's credential parsing and receipt
handling, preserves ordinary payment challenges, and renders errors with status 500 or higher as JSON problem bodies
without `WWW-Authenticate`. The same transport option works with mppx's Express and Hono factories. It is an HTTP
transport, not an MCP transport.

The mppx 0.8.17 default HTTP transport attaches a payment challenge even to a 500 error. `paymentHttpTransport` corrects
that response behavior without replacing the payment middleware. Applications importing mppx directly must also pass
this option; importing an InFlow payment method alone does not replace their transport.

A malformed validation response or a missing or mismatched settlement receipt produces `MppCredentialProblemError` with
status 500. A valid platform payment rejection retains status 402 and its problem details. After an internal settlement
failure, do not infer that payment failed or create a replacement purchase: the outcome may be unknown. This correction
concerns malformed platform responses; mppx's handling of other untyped exceptions remains upstream behavior.

- `apiKey` → `inflow({ apiKey })` — your InFlow API key; authenticates the InFlow REST calls.

`Mppx.create` additionally takes a `secretKey` (or the `MPP_SECRET_KEY` env var). It must contain at least 32 bytes;
generate one with `openssl rand -base64 32`. See the [`mppx`](https://github.com/wevm/mppx) docs for how it is used.

## Rails — derived from the charge currency

The rail is determined by the charge currency, using the server-authoritative map from `GET /v1/mpp/config`:

| Charge currency          | Rail         | Result                                                 |
| ------------------------ | ------------ | ------------------------------------------------------ |
| Crypto (e.g. `USDC`)     | `balance`    | one challenge; no extra params                         |
| Fiat (`USD`)             | `instrument` | buyer selects a linked card or uses their primary card |
| Unsupported (e.g. `JPY`) | —            | `MppUnsupportedCurrencyError`                          |

Configuration loading starts when the method is constructed. Concurrent callers share the request, and successful
configuration stays cached for that method's lifetime. If loading fails, a later request can try again; there is no
background retry loop. `createConfigClient` exposes the loader directly for inspecting configuration.

## Quickstart

```ts
import { Mppx, inflow, paymentHttpTransport } from '@inflowpayai/mpp-seller';

const mppx = Mppx.create({
  transport: paymentHttpTransport(),
  methods: [
    inflow({
      apiKey: process.env.INFLOW_API_KEY!,
      environment: 'sandbox',
      // Method-level policy: hide this offer from callers that do not meet route-specific requirements.
      canOffer: ({ input }) => input.headers.get('x-market') !== 'blocked',
    }),
  ],
  // Server-level policy: select a stable, ordered subset after every method's canOffer gate runs.
  selectOffers: (offers, { request }) =>
    request.headers.get('x-usdc-only') === 'true'
      ? offers.filter((offer) => offer.request.currency === 'USDC')
      : offers,
  secretKey: process.env.MPP_SECRET_KEY,
});

export async function handler(req: Request) {
  const r = await mppx.charge({ amount: '0.01', currency: 'USDC' })(req);
  if (r.status === 402) return r.challenge;
  return r.withReceipt(Response.json({ data: '…' }));
}
```

`canOffer` and `selectOffers` control which challenges are issued for a request; they are not authorization checks. An
already-issued credential can still be redeemed after an offer becomes ineligible. Enforce access policy separately.
When `canOffer` rejects every offer, the composed handler rejects with
`No payment offers are available for this request`. A `selectOffers` hook must return at least one offer. Map policy
failures to the response appropriate for your application at its HTTP boundary.

`inflow.subscription(...)` accepts the same `canOffer` option, with recurring fields such as `periodUnit`,
`periodCount`, and `subscriptionExpires` available on its typed `request` argument. Its options type is
`InflowSubscriptionSellerParameters`.

This package ships no middleware of its own; use `mppx`'s framework adapters (`mppx/express`, `mppx/hono`,
`mppx/nextjs`, `mppx/elysia`) or the manual mode above. See
[`examples/mpp-seller-express`](../../examples/mpp-seller-express) and
[`examples/mpp-seller-hono`](../../examples/mpp-seller-hono) for the complete runnable shape.

## USD payments with an InFlow linked card

Use `inflow(...)` with `currency: 'USD'` to accept ordinary linked-card payments from InFlow buyers. The seller needs a
connected Stripe account that can accept charges. The buyer links a card in their own InFlow account and approves the
purchase, or an existing policy approves it. InFlow then charges that card through Stripe when the seller redeems the
credential. Ordinary card payments do not use a VIC allowance.

The seller chooses the price, not the buyer's card. Supply amounts such as `'1.00'` in dollars, with a minimum of USD
0.50 and no fractional cents. The SDK derives `instrument` from the server's USD capability; explicitly setting
`methodDetails: { rail: 'instrument' }` restricts the offer to that rail. Do not put a buyer Instrument ID into a public
challenge. The buyer sends `options.instrumentId` to InFlow, or omits it to use their primary card. An existing
challenge that pins `methodDetails.instrumentId` constrains that selection; it does not give the seller access to the
card.

For a runnable USD-only route, use
[`examples/mpp-seller-express`](../../examples/mpp-seller-express#usd-linked-card-example) and `pnpm start:instrument`.
The application uses only its InFlow Seller API key and challenge-signing secret, not Stripe keys or raw card details.

Only serve the paid response after settlement succeeds. A `ready` buyer credential is authorization to attempt payment,
not proof of settlement. If the bank requires verification, the payment remains pending while the buyer completes the
dashboard step. The seller must accept a retry of the original request and credential without creating a second order.
See [buyer verification and recovery](../mpp/README.md#card-verification-and-payment-status).

These offers use `inflow/charge` on the `instrument` rail. VIC uses `card/charge`; Stripe Shared Payment Tokens use
`stripe/charge`, described below. They are separate payment methods, even when Stripe processes the final charge.

## Stripe one-time charges

Connect your Stripe account through the InFlow dashboard and ensure the account has an eligible Stripe business profile
before enabling Stripe payments. Your application needs an InFlow Seller API key, not a Stripe secret key. InFlow uses
its platform credentials and your connected-account ID to process payments on your Stripe account.

Stripe challenges use the official `mppx@^0.8.17` `stripe/charge` schema. The seller SDK reads your Stripe
business-profile ID (`networkId`) and allowed payment methods from `GET /v1/mpp/config`. For that reason, `stripe(...)`
is asynchronous and fails at initialization if the required Stripe profile is unavailable.

```ts
import { Mppx, stripe } from '@inflowpayai/mpp-seller';

const stripeMethod = await stripe({
  apiKey: process.env.INFLOW_API_KEY!,
  environment: 'sandbox',
});

const mppx = Mppx.create({
  methods: [stripeMethod],
  secretKey: process.env.MPP_SECRET_KEY,
});

export async function handler(request: Request) {
  const result = await mppx.charge({ amount: '1.00', externalId: 'order-123' })(request);
  if (result.status === 402) return result.challenge;
  return result.withReceipt(Response.json({ access: 'granted' }));
}
```

The method accepts USD amounts from `0.50` through `999999.99`, with no more than two fractional digits. It rejects
values such as `0.49` or `0.501` before issuing a challenge instead of rounding them. The SDK always replaces any
caller-supplied profile id, currency, decimals, or payment-method list with the authenticated server configuration. Only
one-time Stripe charges are supported; this method does not advertise subscriptions or InFlow buyer initiation.

If you include an `externalId` in the challenge, the buyer's credential must echo it exactly. Credentials with a missing
or different reference are rejected before payment. When the challenge has no `externalId`, a buyer reference is
optional.

For composed offers, `canOffer` receives the same authoritative request as the issued challenge, with the amount in
integer cents. Metadata allows up to 45 string entries, with keys up to 40 characters and values up to 500 characters;
keys cannot be blank, contain square brackets, or use `externalId`, `inflowMppTransactionId`, `mppChallengeId`,
`mppIntent`, `mppMethod`, or `stripeNetworkProfile`.

## CARD network-token payments

Connect a charge-enabled Stripe account in your InFlow Seller dashboard. Then add `card(...)` to the payment methods
your application offers. This is separate from `stripe(...)`: CARD accepts encrypted Visa network-token credentials,
whereas `stripe(...)` accepts Stripe Shared Payment Tokens. Choose either or both for your routes. CARD does not require
the Stripe business-profile capability used by the Shared Payment Token method.

```ts
import { Mppx, card } from '@inflowpayai/mpp-seller';

const apiKey = process.env['INFLOW_API_KEY'];
const secretKey = process.env['MPP_SECRET_KEY'];
if (!apiKey || !secretKey) throw new Error('Set INFLOW_API_KEY and MPP_SECRET_KEY.');

const payments = Mppx.create({
  methods: [await card({ apiKey, environment: 'sandbox' })],
  secretKey,
});

export async function handler(request: Request): Promise<Response> {
  const result = await payments.charge({ amount: '1.00', externalId: 'order-123', scope: 'GET /report' })(request);
  if (result.status === 402) return result.challenge;
  return result.withReceipt(Response.json({ access: 'granted' }));
}
```

Pass the price in dollars: `"1.00"` becomes `"100"` integer cents in the challenge. Supported prices range from USD 0.50
through 999999.99, with at most two fractional digits; extra precision is rejected, not rounded. `externalId` is an
optional order reference of at most 255 characters. CARD receipts use the challenge's reference; the buyer does not need
to repeat it in the credential payload. Set `billingRequired: true` on a charge when billing address information is
required.

The factory loads `GET /v1/mpp/config` once, using your InFlow Seller API key. Its configuration supplies the recipient,
merchant name, accepted network and public encryption key; route parameters cannot replace them. Recreate the method or
restart the application after changing the connected account or rotating the advertised public key. InFlow keeps the
encryption private keys. Sellers do not need to configure those keys or pass Stripe API credentials to the SDK.

Your `MPP_SECRET_KEY` has a different purpose: mppx uses it to sign and verify your application's challenges. Retain it
across restarts. The HTTP handler checks the challenge binding and expiration before forwarding a credential. InFlow's
non-mutating `/validate` endpoint checks the credential, and `/broadcast` processes payment and enforces replay
protection. Content is released only with a successful CARD receipt for that challenge. Pending or rejected payments
remain payment failures rather than successful responses.

Set a distinct `scope` for each protected operation, especially with Express or a manual Fetch handler. Include an order
or resource identifier when access is specific to that item. Hono supplies a route-pattern scope automatically; Express
does not. A common price and signing secret alone do not distinguish two resources.

The encrypted payload is forwarded without decryption or inspection. Do not log credentials or billing details. InFlow
buyers use the [buyer package's `card` method](../mpp-buyer/README.md#pay-a-card-offer-with-a-vic-allowance), with a
linked Visa card and a verified VIC allowance. External buyers can supply compatible encrypted Visa network-token
credentials without an InFlow buyer account. This seller package does not mint those credentials or provide a card-entry
form. Application login, if your service requires it, is separate from payment acceptance.

For composed offers, `canOffer` receives the configured request with the amount in cents, as it does for `stripe(...)`.
Use `mppx.compose([cardMethod, { amount: '1.00' }], [stripeMethod, { amount: '1.00' }])` on a core `Mppx` instance to
advertise both methods. See the runnable [`CARD Express example`](../../examples/mpp-card-seller-express) and the
[CARD charge draft](https://paymentauth.org/draft-card-charge-00.html). The supported InFlow profile is USD, Visa,
one-time charges and embedded encryption keys; it does not expose remote key discovery or subscriptions.

## Multiple currencies

`charge(...)` advertises **one** currency per route. Per the MPP core spec, multiple currencies are multiple challenges
— so to accept several currencies on one route you emit one `WWW-Authenticate` challenge per currency via
`compose(...)`. The framework adapters (`mppx/express`, `mppx/hono`, …) intentionally expose only `charge` and **strip
`compose`**, so the multi-currency path runs on the core `mppx/server` instance. `inflowCharges` /
`inflowChargesNodeListener` wrap that:

```ts
import { Mppx, inflow, inflowChargesNodeListener } from '@inflowpayai/mpp-seller';

// Core instance (mppx/server) — keeps compose(). A single instance can also serve single-currency routes.
const mppx = Mppx.create({
  methods: [inflow({ apiKey: process.env.INFLOW_API_KEY!, environment: 'sandbox' })],
  secretKey: process.env.MPP_SECRET_KEY,
});

// One challenge per price. USD → instrument rail, USDC → balance rail (the method derives each rail from the currency).
const checkout = inflowChargesNodeListener(mppx, [
  { amount: '1.0', currency: 'USD' },
  { amount: '0.0095', currency: 'USDC' },
]);
// Mount `checkout(req, res)` on a Node http server or Express route; use `inflowCharges(mppx, prices)` for the raw
// Web-fetch handler (e.g. on Hono via `c.req.raw`).
```

The buyer selects one challenge and pays it; `compose` matches the returned credential back to the right entry by its
currency. Amounts are per-currency and independent (not a converted exchange rate). An unsupported currency throws
`MppUnsupportedCurrencyError` at request time, exactly as with `charge`. See
[`examples/mpp-seller-express`](../../examples/mpp-seller-express) and
[`examples/mpp-seller-hono`](../../examples/mpp-seller-hono) for the `GET /api/checkout` route.

## Subscriptions

InFlow subscriptions let a seller protect a resource with recurring MPP payment terms. The buyer reviews and approves
the immutable terms, and activation charges the first billing period. InFlow manages later billing attempts, past-due
and terminal states, and buyer or seller cancellation. When an active subscriber requests the resource again, the buyer
obtains a fresh, short-lived authorization for the seller's current challenge; the integration does not store a reusable
buyer credential.

Subscriptions use the InFlow `balance` rail. They do not require the buyer or seller to operate a blockchain wallet, and
they do not use Tempo subscription authorizations.

Each plan contains:

| Field                 | Meaning                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `amount`              | Positive decimal amount charged each period, in the currency's units.                   |
| `currency`            | Currency code. Subscription settlement currently requires a balance-supported currency. |
| `periodUnit`          | `hour`, `day`, `week`, `month`, `quarter`, or `year`.                                   |
| `periodCount`         | Positive number of period units between charges.                                        |
| `subscriptionExpires` | RFC 3339 timestamp after which the subscription cannot renew.                           |
| `externalId`          | Optional seller reference for reconciliation; it is not an authorization or lookup key. |

The SDK also accepts `minute` for controlled testing, with a minimum `periodCount` of `5`. Do not advertise minute plans
to customers.

### Fetch API frameworks

Use a core `mppx/server` instance because subscription routes may advertise several plans. The framework-specific mppx
adapters expose the single-offer `charge` API but not the required `compose` API.

```ts
import { Mppx, inflow, inflowSubscriptions } from '@inflowpayai/mpp-seller';

const subscriptions = Mppx.create({
  methods: [
    inflow.subscription({
      apiKey: process.env.INFLOW_API_KEY!,
      environment: 'sandbox',
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY,
});

const subscribe = inflowSubscriptions(subscriptions, [
  {
    amount: '9.99',
    currency: 'USDC',
    periodUnit: 'month',
    periodCount: 1,
    subscriptionExpires: '2027-12-31T23:59:59Z',
    externalId: 'pro-monthly',
  },
]);

export async function handler(request: Request): Promise<Response> {
  const result = await subscribe(request);
  if (result.status === 402) return result.challenge;
  return result.withReceipt(Response.json({ access: 'granted' }));
}
```

For Hono, pass `c.req.raw` to the handler and return either `result.challenge` or `result.withReceipt(c.json(...))`. See
the complete [`mpp-seller-hono`](../../examples/mpp-seller-hono) example.

### Express and Node HTTP

`inflowSubscriptionsNodeListener` adapts the Fetch handler to a Node request and response pair:

```ts
import express from 'express';
import { Mppx } from 'mppx/server';
import { inflow, inflowSubscriptionsNodeListener } from '@inflowpayai/mpp-seller';

const subscriptions = Mppx.create({
  methods: [
    inflow.subscription({
      apiKey: process.env.INFLOW_API_KEY!,
      environment: 'sandbox',
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY,
});

const subscribe = inflowSubscriptionsNodeListener(subscriptions, [
  {
    amount: '9.99',
    currency: 'USDC',
    periodUnit: 'month',
    periodCount: 1,
    subscriptionExpires: '2027-12-31T23:59:59Z',
    externalId: 'pro-monthly',
  },
]);

const app = express();
app.get('/api/subscribe', async (request, response) => {
  const result = await subscribe(request, response);
  if (result.status === 402) return;
  response.json({ access: 'granted' });
});
```

The subscription method verifies each presented credential through InFlow. Keep the InFlow API key and `MPP_SECRET_KEY`
server-side. The MPP secret must contain at least 32 bytes and remain stable across deployments so previously issued
challenges can still be verified. See the complete [`mpp-seller-express`](../../examples/mpp-seller-express) example.

## See also

- [@inflowpayai/mpp](../mpp) — core MPP `Method` definitions, wire types, codec, HTTP client
- [Product overview](../../docs/mpp/README.md)
- [Architecture](../../docs/mpp/architecture.md) — InFlow-as-PSP boundary, package layering
- Examples: [`mpp-seller-express`](../../examples/mpp-seller-express),
  [`mpp-seller-hono`](../../examples/mpp-seller-hono)

## License

MIT
