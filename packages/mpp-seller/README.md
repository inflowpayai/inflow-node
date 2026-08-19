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

Broadcasts use the server-issued `authorizationId` or `transactionId` as the HTTP idempotency key when available.
Externally produced Tempo credentials may contain neither identifier; in that case the SDK deliberately omits the header
and the InFlow server's credential replay slot remains the settlement guard.

## What's exported

- `inflow(parameters)` — the seller `inflow` method. Pass it to
  `Mppx.create({ methods: [inflow({ apiKey })], secretKey })`. Its `validate` hook checks the submitted credential
  through InFlow without consuming payment state (`POST /v1/mpp/validate`); `broadcast` revalidates and performs the
  authoritative terminal operation (`POST /v1/mpp/broadcast`). `mppx` coordinates both hooks during payment handling.
- `tempo(parameters)` — the seller `tempo` method for Tempo TIP-20 charges. Pass it to
  `Mppx.create({ methods: [tempo({ apiKey, currency, recipient })], secretKey })`. Fee-payer sponsorship defaults to
  off; set `methodDetails.feePayer: true` (on the method or per charge) to mint a sponsored challenge.
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
- Types: `InflowSellerParameters`, `TempoSellerParameters`, `LoadedConfig`, `InflowChargePrice`, plus the core
  re-exports `Environment`, `MppCurrencyRail`, `MppProblemDetail`, `MppReceipt`.
- Errors: `MppUnsupportedCurrencyError` (charge currency has no rail in the PSP config), `MppCredentialProblemError`
  (credential validation or broadcast failed; carries the PSP's RFC 9457 problem).

## Configuration

- `apiKey` → `inflow({ apiKey })` — your InFlow API key; authenticates the InFlow REST calls.

`Mppx.create` additionally takes a `secretKey` (or the `MPP_SECRET_KEY` env var). It must contain at least 32 bytes;
generate one with `openssl rand -base64 32`. See the [`mppx`](https://github.com/wevm/mppx) docs for how it is used.

## Rails — derived from the charge currency

The rail is determined by the charge currency, using the server-authoritative map from `GET /v1/mpp/config`:

| Charge currency          | Rail         | Result                                               |
| ------------------------ | ------------ | ---------------------------------------------------- |
| Crypto (e.g. `USDC`)     | `balance`    | one challenge; no extra params                       |
| Fiat (e.g. `USD`)        | `instrument` | one challenge; `methodDetails.instrumentId` optional |
| Unsupported (e.g. `JPY`) | —            | `MppUnsupportedCurrencyError`                        |

The capability map is fetched once and cached at startup. `createConfigClient` exposes that loader directly, if you want
to prime or inspect the config yourself.

## Quickstart

```ts
import { Mppx, inflow } from '@inflowpayai/mpp-seller';

const mppx = Mppx.create({
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

This package ships no middleware of its own; use `mppx`'s framework adapters (`mppx/express`, `mppx/hono`,
`mppx/nextjs`, `mppx/elysia`) or the manual mode above. See
[`examples/mpp-seller-express`](../../examples/mpp-seller-express) and
[`examples/mpp-seller-hono`](../../examples/mpp-seller-hono) for the complete runnable shape.

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
