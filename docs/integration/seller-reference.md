# InFlow Seller Integration — Complete Reference

A standalone, end-to-end reference for accepting **agent-native payments** as a seller with InFlow's Node.js SDKs. This
covers both supported protocols (x402 and MPP), the concepts behind each, every configuration knob a seller touches,
multi-facilitator routing, error handling, and the move from sandbox to production.

If you just want to copy-paste a working server, start with **[seller-quickstart.md](./seller-quickstart.md)** (the
quickstart). This document is the deeper companion.

---

## Table of contents

1. [What InFlow does for a seller](#1-what-inflow-does-for-a-seller)
2. [Choosing a protocol: x402 vs MPP](#2-choosing-a-protocol-x402-vs-mpp)
3. [Accounts, API keys, environments](#3-accounts-api-keys-environments)
4. [x402 in depth](#4-x402-in-depth)
5. [MPP in depth](#5-mpp-in-depth)
6. [Schemes and rails](#6-schemes-and-rails)
7. [Price and amount formats (x402)](#7-price-and-amount-formats-x402)
8. [Multiple facilitators (x402)](#8-multiple-facilitators-x402)
9. [Extensions](#9-extensions)
10. [Error handling](#10-error-handling)
11. [Sandbox → production](#11-sandbox--production)
12. [Troubleshooting](#12-troubleshooting)
13. [Framework references](#13-framework-references)

---

## 1. What InFlow does for a seller

InFlow is a **PSP (payment service provider)**. Your server exposes paid resources. When a request arrives without
payment, you answer `402 Payment Required` with a challenge. The buyer — a human-operated wallet or an autonomous agent
— fulfils the challenge and retries. InFlow **verifies** the payment is valid and **settles** the funds into your InFlow
seller account.

The InFlow SDKs are thin glue over InFlow's REST API. They do **not** reimplement the payment protocol engine: for x402
the foundation `@x402/*` middleware owns the wire mechanics, and for MPP the `mppx` SDK owns challenge minting and
binding. The InFlow packages contribute the verify/settle driver, the seller config, and the helpers that turn your
config into the per-route payment options.

The buyer in both protocols can be an agent. That's the point of agent-native payments: the `402` → pay → retry loop is
fully machine-executable, so an autonomous buyer can pay for your resource without a human in the loop.

---

## 2. Choosing a protocol: x402 vs MPP

**Your integration commits to one protocol — it's an all-or-nothing decision.** x402 and MPP are distinct wire protocols
with distinct SDKs; you build your seller around one of them and don't need the other. Decide up front, before writing
any code, and follow only that protocol's section of this guide.

|                            | **x402**                                                               | **MPP**                                                                      |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Spec                       | [x402 protocol](https://docs.x402.org)                                 | IETF "Payment" HTTP auth scheme ([paymentauth.org](https://paymentauth.org)) |
| Seller package             | `@inflowpayai/x402-seller`                                             | `@inflowpayai/mpp-seller`                                                    |
| Peer SDK                   | `@x402/core@^2.12.0` + a framework adapter (`@x402/express` etc.)      | [`mppx@^0.6.28`](https://github.com/wevm/mppx)                               |
| Wiring                     | Global middleware listing priced routes                                | Per-route `charge()` handler                                                 |
| Challenge transport        | `PAYMENT-REQUIRED` response header (base64 JSON)                       | `WWW-Authenticate: Payment …` response header(s)                             |
| Buyer's paid retry         | `PAYMENT-SIGNATURE` request header                                     | `Authorization: Payment <credential>` request header                         |
| Success receipt            | `PAYMENT-RESPONSE` response header                                     | `Payment-Receipt` response header                                            |
| Settlement rails           | InFlow ledger (`balance`) + on-chain (`exact`) + reserved `instrument` | InFlow `balance` (crypto) + `instrument` (fiat)                              |
| Multiple PSPs/facilitators | Yes — order an array of facilitators                                   | Single InFlow method                                                         |

**Rule of thumb.** Choose **x402** if you want the x402 ecosystem, on-chain stablecoin transfers (EVM/Solana/etc.), or
the ability to route across several facilitators. Choose **MPP** if you're standardizing on the IETF Payment auth scheme
and want InFlow to settle crypto and fiat rails.

---

## 3. Accounts, API keys, environments

1. **Register a Seller account.**
   - Sandbox: **https://sandbox.inflowpay.ai**
   - Production: **https://app.inflowpay.ai**
2. **Create an API key** in the dashboard → this is your `INFLOW_API_KEY`.
3. For MPP you additionally need an **HMAC secret** (`MPP_SECRET_KEY`) used by `mppx` to mint and bind challenges.

**Environments.** Every SDK factory takes an `environment` of `'sandbox' | 'production'` (default `'production'`).
That's the only endpoint configuration you provide — the SDK resolves the rest internally, so you never set a URL.

| `environment`  | Register / get your API key at |
| -------------- | ------------------------------ |
| `'sandbox'`    | `https://sandbox.inflowpay.ai` |
| `'production'` | `https://app.inflowpay.ai`     |

For network egress allowlisting only: the SDK's outbound API calls go to `sandbox.inflowpay.ai` (sandbox) and
`api.inflowpay.ai` (production). You never reference these in code.

**Runtime.** Node 22 LTS or newer (`engines.node: >=22.0.0`). Node 20 is EOL and unsupported.

**Never commit a `baseUrl` override.** The factories accept an optional `baseUrl`, but it's for internal testing only
and takes precedence over `environment`. In normal use, pass `environment` and nothing else.

---

## 4. x402 in depth

### 4.1 Packages

| Package                    | Role                                                 | Install when                                        |
| -------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `@inflowpayai/x402`        | Core types + HTTP client                             | Rarely installed directly (pulled in transitively). |
| `@inflowpayai/x402-seller` | Facilitator client + seller client + `inflowAccepts` | Accepting x402 payments.                            |
| `@inflowpayai/x402-buyer`  | Buyer client                                         | Only if you also _pay_ via x402.                    |

Install for an Express seller:

```bash
pnpm add @inflowpayai/x402-seller @x402/express @x402/core express
```

### 4.2 The model

The x402-seller package **does not ship a middleware**. You use the foundation's `paymentMiddlewareFromConfig` (from
`@x402/express`, `@x402/hono`, `@x402/fastify`, or `@x402/next`) and pass InFlow's facilitator into its
`facilitatorClients` array. InFlow is "just another facilitator" the foundation can route verify/settle to.

### 4.3 The four exports a seller uses

- **`createInflowFacilitator({ environment, apiKey })`** → a foundation `FacilitatorClient` (`verify` / `settle` /
  `getSupported`). `apiKey` is required at the type level so an env-var omission can't silently degrade to an
  unauthenticated mode.
- **`createUnauthenticatedInflowFacilitator({ environment })`** → the same shape but sends no `X-API-KEY` header. The
  explicit escape hatch for facilitator-only / public-facilitator / test-harness deployments. Most sellers do not use
  this.
- **`createInflowSellerClient({ environment, apiKey })`** → async factory returning an `InflowSellerClient`. Owns the
  seller-authed `/v1/x402/config` endpoint and signer-address discovery, and drives `inflowAccepts`. It primes its
  config + supported caches in parallel before resolving (60-minute TTL), which is why it's `await`ed.
- **`inflowAccepts(seller, options)`** → async; expands your config into a foundation `PaymentOption[]` ready to splat
  into a route's `accepts`. Prices are pre-resolved to atomic asset amounts.
- **`inflowSchemeRegistrations(seller)`** → async; returns one passthrough `SchemeRegistration` per `(scheme, network)`
  pair your server can emit. Pass these as the **third argument** to `paymentMiddlewareFromConfig`. The foundation
  refuses to boot without registrations covering every advertised scheme (it aborts with a `RouteConfigurationError`).

### 4.4 `inflowAccepts` options

```ts
await inflowAccepts(seller, {
  price: '$0.01', // required — see §7 for all forms
  schemes: ['balance', 'exact'], // optional filter; omit for "any scheme"
  networks: ['inflow:1'], // optional filter; omit for "any network"
  maxTimeoutSeconds: 300, // optional; default 300
});
```

`schemes` and `networks` combine as a logical AND. Omitting both emits every option your seller config supports for that
price.

### 4.5 Full Express server

```ts
import 'dotenv/config';
import express from 'express';
import { paymentMiddlewareFromConfig } from '@x402/express';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '@inflowpayai/x402-seller';

const apiKey = process.env.INFLOW_API_KEY;
if (!apiKey) process.exit(1);

const inflow = createInflowFacilitator({ environment: 'sandbox', apiKey });
const seller = await createInflowSellerClient({ environment: 'sandbox', apiKey });

const app = express();
app.use(express.json());
app.use(
  paymentMiddlewareFromConfig(
    {
      'GET /api/widgets': { accepts: await inflowAccepts(seller, { price: '$0.01' }) },
      'POST /api/upload': {
        accepts: await inflowAccepts(seller, { price: '0.10 USDC', schemes: ['balance', 'exact'] }),
      },
    },
    [inflow],
    await inflowSchemeRegistrations(seller),
  ),
);
app.get('/api/widgets', (_req, res) => res.json({ widgets: [1, 2, 3] }));
app.post('/api/upload', (_req, res) => res.json({ status: 'received' }));
app.listen(3000);
```

### 4.6 The x402 wire, briefly

- Unpaid request → `402` with a base64-JSON challenge in the **`PAYMENT-REQUIRED`** header.
- Buyer pays and retries with the **`PAYMENT-SIGNATURE`** header.
- On success the seller returns a **`PAYMENT-RESPONSE`** header alongside your normal `200` body.

You don't construct these by hand — the middleware does. Knowing the header names helps when inspecting traffic or
debugging.

---

## 5. MPP in depth

### 5.1 Packages

| Package                   | Role                                                                 | Install when                    |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------- |
| `@inflowpayai/mpp`        | Core: the `inflow` method definition, wire types, codec, HTTP client | Rarely installed directly.      |
| `@inflowpayai/mpp-seller` | `Method.toServer` + InFlow redeem/settle driver                      | Accepting MPP payments.         |
| `@inflowpayai/mpp-buyer`  | `Method.toClient` + buyer driver                                     | Only if you also _pay_ via MPP. |

Install for an Express seller:

```bash
pnpm add @inflowpayai/mpp-seller mppx
```

`mppx` is a peer dependency. The seller package re-exports `Mppx` (from `mppx/server`) so a single import gives you both
the foundation server and the InFlow method.

### 5.2 The model

MPP is the IETF "Payment" auth scheme. The seller **issues the challenge locally** — there is no server round-trip to
mint one. The buyer pays, and InFlow correlates the redemption by the transaction id carried in the credential and
settles. `mppx` owns challenge minting + HMAC binding; the InFlow `inflow` method's `verify` redeems and settles via
`POST /v1/mpp/redeem`.

### 5.3 Exports a seller uses

- **`inflow({ apiKey, environment })`** — the seller `inflow` method. Pass into
  `Mppx.create({ methods: [inflow({ apiKey })], secretKey })`. Its `verify` redeems + settles through InFlow.
- **`inflowCharges(coreMppx, prices)`** — accept several currencies on one route. Returns the Web-fetch handler from
  `compose(...)` — one challenge per `{ amount, currency }`. The MPP analog of x402-seller's `inflowAccepts`. See §5.6.
- **`inflowChargesNodeListener(coreMppx, prices)`** — the same, wrapped with `Mppx.toNodeListener` so it mounts directly
  on a Node `http` server or Express route.
- **`createConfigClient(client)`** — exposes the `GET /v1/mpp/config` loader directly, so you can prime or inspect the
  currency→rail capability map yourself. Returns an `InflowConfigClient`.
- **`Mppx`, `Expires`** (re-exported from `mppx/server`) and **`Receipt`** (from `mppx`).
- Types: **`InflowChargePrice`** (`{ amount, currency }`), `InflowSellerParameters`, `LoadedConfig`.
- Errors: **`MppUnsupportedCurrencyError`**, **`MppRedeemProblemError`** (see §10).

### 5.4 Full Express server

```ts
import 'dotenv/config';
import express from 'express';
import { Mppx } from 'mppx/express';
import { inflow } from '@inflowpayai/mpp-seller';

const apiKey = process.env.INFLOW_API_KEY;
if (!apiKey) process.exit(1);

const mppx = Mppx.create({
  methods: [inflow({ apiKey, environment: 'sandbox' })],
  secretKey: process.env.MPP_SECRET_KEY, // HMAC secret used to bind challenges
});

const app = express();
app.use(express.json());

app.get('/api/widgets', mppx.charge({ amount: '0.01', currency: 'USDC' }), (_req, res) =>
  res.json({ widgets: [1, 2, 3] }),
);
app.post('/api/upload', mppx.charge({ amount: '0.10', currency: 'USDC' }), (_req, res) =>
  res.json({ status: 'received' }),
);
app.listen(3000);
```

### 5.5 `secretKey` / `MPP_SECRET_KEY`

`Mppx.create` requires a `secretKey` (or the `MPP_SECRET_KEY` env var). This is the HMAC secret `mppx` uses to mint and
bind challenges so a credential can't be replayed against a different challenge. It is **not** your InFlow API key —
keep both secret, use distinct values per environment, and supply at least 32 bytes. Generate one with
`openssl rand -base64 32`. See the [`mppx` docs](https://github.com/wevm/mppx) for details.

### 5.6 Multiple currencies on one route

`mppx.charge({ amount, currency })` advertises **one** currency per route. Per the MPP core spec, multiple currencies
are multiple challenges — so to accept several on one route you emit one `WWW-Authenticate` challenge per currency. The
framework adapters (`mppx/express`, `mppx/hono`) intentionally expose only `charge` and **strip `compose`**, so the
multi-currency path runs on the **core `mppx/server`** instance. The package wraps it for you with `inflowCharges`
(returns the raw Web-fetch handler) and `inflowChargesNodeListener` (wraps it with `Mppx.toNodeListener` for
Node/Express).

Each price is an independent `{ amount, currency }` — not a converted exchange rate — and each currency derives its own
rail (crypto → `balance`, fiat → `instrument`). The buyer picks one challenge and pays it; `compose` matches the
returned credential back to the right entry by its currency. An unsupported currency throws
`MppUnsupportedCurrencyError` at request time, exactly as with `charge`.

Because the adapter and the core instance expose different APIs, build the `inflow` method once and stand up both over
it — sharing the method object avoids a second `/config` fetch. The framework `mppx` serves your single-currency
`charge` routes; the `core` instance serves the multi-currency ones.

**Express** (via `inflowChargesNodeListener`):

```ts
import { Mppx } from 'mppx/express';
import { Mppx as MppxServer } from 'mppx/server';
import { inflow, inflowChargesNodeListener } from '@inflowpayai/mpp-seller';

const method = inflow({ apiKey, environment: 'sandbox' });
const secretKey = process.env.MPP_SECRET_KEY;
const mppx = Mppx.create({ methods: [method], secretKey }); // single-currency charge routes
const core = MppxServer.create({ methods: [method], secretKey }); // multi-currency compose routes

const checkout = inflowChargesNodeListener(core, [
  { amount: '1.0', currency: 'USD' }, // → instrument rail
  { amount: '0.0095', currency: 'USDC' }, // → balance rail
]);

app.get('/api/checkout', async (req, res) => {
  const result = await checkout(req, res);
  if (result.status === 402) return; // challenge already written
  res.json({ ok: true }); // 200: Payment-Receipt header already set
});
```

**Hono** (via `inflowCharges` + the fetch-native `c.req.raw`):

```ts
import { inflow, inflowCharges } from '@inflowpayai/mpp-seller';

const checkout = inflowCharges(core, [
  { amount: '1.0', currency: 'USD' },
  { amount: '0.0095', currency: 'USDC' },
]);

app.get('/api/checkout', async (c) => {
  const result = await checkout(c.req.raw);
  if (result.status === 402) return result.challenge;
  return result.withReceipt(c.json({ ok: true }));
});
```

### 5.7 The MPP wire, briefly

- Unpaid request → `402` with one or more **`WWW-Authenticate: Payment …`** headers and `Cache-Control: no-store`.
- Buyer pays and retries with **`Authorization: Payment <credential>`**.
- On success the seller returns a **`Payment-Receipt`** header.

`charge()` (single currency) and `inflowCharges` (multiple) both handle all of this; you only declare the price(s).

---

## 6. Schemes and rails

### 6.1 x402 schemes

The x402 SDK supports three schemes:

- **`balance`** — an InFlow-internal ledger transfer between two InFlow accounts. No on-chain transaction, no gas; the
  fastest path. Uses the literal `inflow:1` network identifier.
- **`exact`** — an on-chain transfer signed via EIP-3009 or Permit2 (EVM) or the chain-specific method (Solana, Aptos,
  Stellar). Uses CAIP-2 network identifiers: `eip155:<chainId>` for EVM (e.g. `eip155:8453` for Base), and the
  spec-strict `solana:<first-32-base58-of-genesis-hash>` for Solana.
- **`instrument`** — reserved. It exists in the type union for forward compatibility; `inflowAccepts` passes it through
  unchanged if a server ever publishes it, but end-to-end settlement is not yet enabled.

Filter which schemes a route offers via `inflowAccepts(..., { schemes: [...] })`.

### 6.2 MPP rails

In MPP the **rail is derived from the charge currency** using the server-authoritative map from `GET /v1/mpp/config` —
the buyer never chooses it:

| Charge currency          | Rail         | Result                                                |
| ------------------------ | ------------ | ----------------------------------------------------- |
| Crypto (e.g. `USDC`)     | `balance`    | One challenge; no extra params.                       |
| Fiat (e.g. `USD`)        | `instrument` | One challenge; `methodDetails.instrumentId` optional. |
| Unsupported (e.g. `JPY`) | —            | Throws `MppUnsupportedCurrencyError`.                 |

The capability map is fetched once and cached at startup. Use `createConfigClient(client)` if you want to prime or
inspect it yourself.

A single route can offer **several** currencies at once (see §5.6) — each one derives its own rail independently from
this same map, so a route advertising `USD` and `USDC` settles the former on `instrument` and the latter on `balance`.

---

## 7. Price and amount formats (x402)

`inflowAccepts`'s `price` accepts either a string or a `PriceSpec` object. The amount string has three forms (all
support up to 8 decimal places):

| Form                                 | Example                                  | Resolved currency                    |
| ------------------------------------ | ---------------------------------------- | ------------------------------------ |
| `$<integer>(.<decimals>)?`           | `'$0.01'`, `'$10.00000001'`              | `USD`                                |
| `<integer>(.<decimals>)? <CURRENCY>` | `'0.01 USDC'`, `'1 USDT'`, `'0.5 PYUSD'` | from the suffix                      |
| `<integer>(.<decimals>)?` (bare)     | `'0.01'`                                 | from `PriceSpec.currency` (required) |

```ts
// equivalent ways to price a route at 10 cents of USDC:
await inflowAccepts(seller, { price: '0.10 USDC' });
await inflowAccepts(seller, { price: { amount: '0.10', currency: 'USDC' } });
```

Known currencies: `'USD'`, `'USDC'`, `'USDT'`, `'PYUSD'` (plus any other string your config supports). If both the
amount string and the `currency` field carry a currency and they disagree, **`currency` wins**. `'USD'` is a wildcard
that matches any stablecoin asset you've configured. A price that parses to none of the forms throws
`X402PriceParseError`.

---

## 8. Multiple facilitators (x402)

The middleware's second argument is an **ordered array** of facilitator clients. The **first claimer** of a
`(scheme, network)` pair (discovered via each client's `getSupported()`) wins verify/settle routing. Order the array
intentionally — later claimers of an already-claimed pair are silently ignored.

```ts
paymentMiddlewareFromConfig(
  {
    /* routes */
  },
  [
    inflow, // claims (balance, inflow:1), (exact, eip155:8453), …
    cdp, // e.g. Coinbase CDP facilitator — claims what InFlow didn't
    partnerFacilitator, // any other FacilitatorClient
  ],
  await inflowSchemeRegistrations(seller),
);
```

If you also register framework-native schemes (e.g. `registerExactEvmScheme()`), append them to the registrations array:

```ts
import { registerExactEvmScheme } from '@x402/evm/exact/client';

paymentMiddlewareFromConfig(routes, [inflow], [...(await inflowSchemeRegistrations(seller)), registerExactEvmScheme()]);
```

---

## 9. Extensions

### x402: `payment-identifier`

The `payment-identifier` extension is supported end to end. It lets a payment carry a caller-supplied id. Per-route
extension declarations live on the route config's `extensions` field; facilitator-wide declarations come from each
facilitator's `getSupported().extensions` and are merged by the middleware automatically. The SDK validates the id
format client-side.

### MPP: `charge` → `session`

The MPP `inflow` method is organised as a namespace that defaults to `charge` (`inflow` and `inflow.charge` are the same
definition today). The namespace path is the extension point for future intents such as `session`.

---

## 10. Error handling

### x402 (seller side)

- **`X402PriceParseError`** — thrown by `inflowAccepts` when a `price` string matches none of the accepted forms. Catch
  it at config-build time (startup), not per-request.
- A `RouteConfigurationError` from the foundation at boot almost always means your `inflowSchemeRegistrations` don't
  cover a `(scheme, network)` your routes advertise — make sure you passed them as the third argument.

### MPP (seller side)

- **`MppUnsupportedCurrencyError`** — the charge currency has no rail in the PSP config (e.g. `JPY`). Thrown when
  `charge()` runs for an unsupported currency. Validate currencies against `GET /v1/mpp/config` (via
  `createConfigClient`) if you accept dynamic currencies.
- **`MppRedeemProblemError`** — redemption failed; carries the PSP's RFC 9457 problem detail (`MppProblemDetail`).
  Inspect its problem `type` (e.g. `payment-expired`, `payment-insufficient`, `verification-failed`) to decide whether
  to surface a new challenge or a hard failure.

Both protocols' clients throw on transport/auth issues (e.g. a bad or missing API key surfaces as an API error from the
underlying HTTP client). Fail fast at startup if `INFLOW_API_KEY` is unset.

---

## 11. Sandbox → production

1. Change `environment: 'sandbox'` → `environment: 'production'` in every SDK factory (`createInflowFacilitator`,
   `createInflowSellerClient`, and/or `inflow({ … })`).
2. Swap your sandbox `INFLOW_API_KEY` for a **production** key created at `https://app.inflowpay.ai`.
3. For MPP, set a production `MPP_SECRET_KEY` (distinct from sandbox).
4. That's it — the SDK targets the right endpoint automatically. Do not set a `baseUrl`.

Keep environment-specific values in env vars (`INFLOW_API_KEY`, `MPP_SECRET_KEY`) so the code path is identical across
environments.

---

## 12. Troubleshooting

- **Foundation middleware won't boot (x402).** You're missing scheme registrations. Pass
  `await inflowSchemeRegistrations(seller)` as the third argument to `paymentMiddlewareFromConfig`, and make sure it
  covers every scheme your routes can emit.
- **`createInflowSellerClient` hangs or rejects.** It makes authed calls at construction to prime caches — check the API
  key and that you're pointed at the right environment.
- **Every request returns `402`, even after paying.** Confirm the buyer is sending the right header (`PAYMENT-SIGNATURE`
  for x402, `Authorization: Payment` for MPP) and that the buyer is speaking the same protocol your integration
  implements.
- **`MppUnsupportedCurrencyError` at request time.** The currency isn't in your PSP config's rail map. Inspect the map
  via `createConfigClient`.
- **You hit an unexpected host / internal box.** You (or an example) passed a `baseUrl`. Remove it and rely on
  `environment`.
- **Node version errors.** The packages require Node 22+. Node 20 is EOL.

---

## 13. Framework references

The integration shape is identical across frameworks; only the adapter import changes.

**x402:**

- [Express](https://github.com/inflowpayai/inflow-node/tree/main/examples/x402-seller-express)
- [Hono](https://github.com/inflowpayai/inflow-node/tree/main/examples/x402-seller-hono)
- [Fastify](https://github.com/inflowpayai/inflow-node/tree/main/examples/x402-seller-fastify) —
  `paymentMiddlewareFromConfig` mutates the Fastify instance in place rather than returning middleware:
  `paymentMiddlewareFromConfig(app, routes, [inflow], regs)`.
- [Next 16](https://github.com/inflowpayai/inflow-node/tree/main/examples/x402-seller-next) — uses a root-level
  `proxy.ts` with `paymentProxyFromConfig` (Next 16 renamed `middleware.ts` → `proxy.ts`); requires a `next` pin
  matching `@x402/next`'s peer range.
- Package: [`@inflowpayai/x402-seller`](https://github.com/inflowpayai/inflow-node/tree/main/packages/x402-seller)

**MPP:**

- [Express](https://github.com/inflowpayai/inflow-node/tree/main/examples/mpp-seller-express) — single-currency `charge`
  routes plus a multi-currency `/api/checkout` route via `inflowChargesNodeListener` (see §5.6).
- [Hono](https://github.com/inflowpayai/inflow-node/tree/main/examples/mpp-seller-hono) — via `mppx/hono` and
  `@hono/node-server`; same `/api/checkout` route via `inflowCharges`.
- Package: [`@inflowpayai/mpp-seller`](https://github.com/inflowpayai/inflow-node/tree/main/packages/mpp-seller)

Available `mppx` framework adapters: `mppx/express`, `mppx/hono`, `mppx/nextjs`, `mppx/elysia`.
