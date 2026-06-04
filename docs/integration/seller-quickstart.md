# InFlow Seller Integration — Quickstart

This guide gets a Node.js seller accepting **agent-native payments** through InFlow in as few steps as possible. InFlow
is the payment service provider (PSP): your server issues a `402 Payment Required` challenge, the buyer (a human wallet
or an autonomous agent) pays, and InFlow verifies and settles the funds into your InFlow seller account.

Everything below uses **Express** and the **sandbox** environment so you can run it end to end before touching
production. Other frameworks (Hono, Fastify, Next 16) follow the identical shape — links at the bottom.

---

## Step 0 — Decide: x402 **or** MPP (pick one)

InFlow supports two payment protocols, and your integration commits to **one of them**. This is an all-or-nothing
choice: x402 and MPP are different wire protocols with different SDKs, and you build your seller around one. Decide
here, before writing any code, and follow only that protocol's section below.

|                       | **x402**                                                                                                              | **MPP** (Machine Payments Protocol)                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **What it is**        | The [x402 protocol](https://docs.x402.org) — InFlow plugs in as a _facilitator_ under the x402 foundation middleware. | The IETF "Payment" HTTP auth scheme ([paymentauth.org](https://paymentauth.org)) — InFlow acts as the PSP that redeems and settles. |
| **SDK package**       | `@inflowpayai/x402-seller`                                                                                            | `@inflowpayai/mpp-seller`                                                                                                           |
| **Built on**          | `@x402/core` + `@x402/express` (foundation middleware)                                                                | [`mppx`](https://github.com/wevm/mppx)                                                                                              |
| **How you wire it**   | One **global** middleware (`app.use(...)`) listing your priced routes.                                                | A **per-route** handler (`mppx.charge(...)`) on each protected route.                                                               |
| **On-chain & ledger** | InFlow balance transfers **and** on-chain `exact` transfers (EVM/Solana/etc.).                                        | InFlow balance (crypto) and instrument (fiat) rails, settled by InFlow.                                                             |
| **Choose it when**    | You want the x402 ecosystem, on-chain stablecoin transfers, or multiple facilitators.                                 | You want the IETF `WWW-Authenticate: Payment` scheme and InFlow-settled rails.                                                      |

If you have no prior commitment, **x402** is the more common starting point for crypto/stablecoin acceptance; **MPP** is
the path if you're standardizing on the IETF Payment auth scheme. Pick one and follow that section below — you don't
need the other.

---

## Step 1 — Create a seller account and get an API key

1. Register a **Seller** account:
   - Sandbox (testing): **https://sandbox.inflowpay.ai**
   - Production (live): **https://app.inflowpay.ai**
2. Create an API key in the dashboard. This is your `INFLOW_API_KEY`.

> You pass `environment: 'sandbox' | 'production'` to the SDK and nothing else — it resolves the right endpoint
> internally, so you never set a URL. (For network egress allowlisting only: outbound API calls go to
> `sandbox.inflowpay.ai` / `api.inflowpay.ai`.)

Requirements: **Node 22 LTS or newer**.

---

## x402 quickstart (Express)

### Install

```bash
pnpm add @inflowpayai/x402-seller @x402/express @x402/core express
# dev-only helper for loading .env:
pnpm add -D dotenv
```

### Configure the environment

Create a `.env` file:

```bash
INFLOW_API_KEY=your_sandbox_key_here
PORT=3000
```

### The server

```ts
// server.ts
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
if (!apiKey) {
  console.error('Set INFLOW_API_KEY (see .env).');
  process.exit(1);
}

// 1. The InFlow facilitator: verify + settle + getSupported. Drops into the
//    foundation middleware's facilitatorClients array.
const inflow = createInflowFacilitator({ environment: 'sandbox', apiKey });

// 2. The seller client: reads your /v1/x402/config and drives inflowAccepts.
//    Async — it primes its caches before resolving.
const seller = await createInflowSellerClient({ environment: 'sandbox', apiKey });

const app = express();
app.use(express.json());

// 3. The foundation middleware. inflowAccepts() expands your seller config
//    into the route's accepts[] (price pre-resolved to asset + atomic amount).
//    inflowSchemeRegistrations() ships the scheme servers the middleware
//    requires at boot — without them it refuses to start.
app.use(
  paymentMiddlewareFromConfig(
    {
      'GET /api/widgets': {
        accepts: await inflowAccepts(seller, { price: '$0.01' }),
      },
      'POST /api/upload': {
        accepts: await inflowAccepts(seller, {
          price: '0.10 USDC',
          schemes: ['balance', 'exact'],
        }),
      },
    },
    [inflow],
    await inflowSchemeRegistrations(seller),
  ),
);

// Your actual handlers run only after payment is verified.
app.get('/api/widgets', (_req, res) => res.json({ widgets: [1, 2, 3] }));
app.post('/api/upload', (_req, res) => res.json({ status: 'received' }));
app.get('/free', (_req, res) => res.json({ ok: true })); // not priced → passes through

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`x402 seller on http://localhost:${port}`));
```

### What each piece does

- **`createInflowFacilitator({ environment, apiKey })`** — returns the facilitator client that verifies and settles
  payments through InFlow. `apiKey` is required.
- **`createInflowSellerClient({ environment, apiKey })`** — async; owns your seller config and signer-address discovery,
  and feeds `inflowAccepts`.
- **`inflowAccepts(seller, { price, schemes?, networks? })`** — turns a price into the `accepts[]` payment options for
  one route. `price` accepts `'$0.01'` (USD), `'0.10 USDC'` (currency from suffix), or a bare `'0.01'` with a `currency`
  field. `schemes`/`networks` are optional filters.
- **`inflowSchemeRegistrations(seller)`** — required third argument to the middleware; registers a scheme server for
  every `(scheme, network)` your config can emit. The middleware won't boot without it.

### Test it

Start the server, then hit a priced route without paying — you'll get a `402` carrying a `PAYMENT-REQUIRED` header:

```bash
curl -i http://localhost:3000/api/widgets   # → HTTP/1.1 402 Payment Required
curl -i http://localhost:3000/free          # → HTTP/1.1 200 OK
```

To run a real paying buyer against it, use the buyer example
([`x402-buyer-fetch`](https://github.com/inflowpayai/inflow-node/tree/main/examples/x402-buyer-fetch)).

### Go to production

Change `environment: 'sandbox'` → `environment: 'production'` everywhere and swap in a **production** API key from
`app.inflowpay.ai`. Nothing else changes — the SDK targets the right endpoint automatically.

---

## MPP quickstart (Express)

### Install

```bash
pnpm add @inflowpayai/mpp-seller mppx
pnpm add -D dotenv
```

### Configure the environment

```bash
INFLOW_API_KEY=your_sandbox_key_here
MPP_SECRET_KEY=your_hmac_secret_here   # used by mppx to bind challenges; see mppx docs
PORT=3000
```

### The server

```ts
// server.ts
import 'dotenv/config';
import express from 'express';
import { Mppx } from 'mppx/express';
import { inflow } from '@inflowpayai/mpp-seller';

const apiKey = process.env.INFLOW_API_KEY;
if (!apiKey) {
  console.error('Set INFLOW_API_KEY (see .env).');
  process.exit(1);
}

// Mppx.create mints + HMAC-binds the 402 challenge (secretKey from MPP_SECRET_KEY).
// The InFlow `inflow` method's verify() redeems + settles through InFlow's PSP.
const mppx = Mppx.create({
  methods: [inflow({ apiKey, environment: 'sandbox' })],
  secretKey: process.env.MPP_SECRET_KEY,
});

const app = express();
app.use(express.json());

// mppx.charge(...) is a per-route handler. The rail is derived from the
// currency (crypto USDC → balance); the buyer never picks it.
app.get('/api/widgets', mppx.charge({ amount: '0.01', currency: 'USDC' }), (_req, res) =>
  res.json({ widgets: [1, 2, 3] }),
);
app.post('/api/upload', mppx.charge({ amount: '0.10', currency: 'USDC' }), (_req, res) =>
  res.json({ status: 'received' }),
);
app.get('/free', (_req, res) => res.json({ ok: true })); // no charge → passes through

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`mpp seller on http://localhost:${port}`));
```

### What each piece does

- **`inflow({ apiKey, environment })`** — the InFlow MPP method. Its `verify` calls InFlow's `/v1/mpp/redeem` to redeem
  and settle. Pass it into `Mppx.create`'s `methods` array.
- **`Mppx.create({ methods, secretKey })`** — the `mppx` server. `secretKey` (or the `MPP_SECRET_KEY` env var) is the
  HMAC secret used to mint and bind challenges; see the [`mppx` docs](https://github.com/wevm/mppx).
- **`mppx.charge({ amount, currency })`** — the per-route handler. Returns a `402` challenge for unpaid requests and
  redeems + settles paid ones. **The rail is chosen by the currency**, not the buyer:
  - crypto (e.g. `USDC`) → `balance` rail
  - fiat (e.g. `USD`) → `instrument` rail
  - unsupported (e.g. `JPY`) → throws `MppUnsupportedCurrencyError`

> **Multiple currencies on one route?** `charge()` advertises a single currency. To let a buyer choose among several
> (e.g. pay in USD _or_ USDC), use the package's `inflowCharges` / `inflowChargesNodeListener` helpers on a core
> `mppx/server` instance — one challenge per currency, each deriving its own rail. See the `/api/checkout` route in the
> [Express](https://github.com/inflowpayai/inflow-node/tree/main/examples/mpp-seller-express) and
> [Hono](https://github.com/inflowpayai/inflow-node/tree/main/examples/mpp-seller-hono) examples.

### Test it

```bash
curl -i http://localhost:3000/api/widgets
# → HTTP/1.1 402 Payment Required
#   WWW-Authenticate: Payment id="…", realm="…", method="inflow", intent="charge", request="…"
```

To run a real paying buyer, use
[`mpp-buyer-fetch`](https://github.com/inflowpayai/inflow-node/tree/main/examples/mpp-buyer-fetch).

### Go to production

Change `environment: 'sandbox'` → `environment: 'production'`, use a production API key from `app.inflowpay.ai`, and set
a production `MPP_SECRET_KEY`. The SDK targets the right endpoint automatically.

---

## Other frameworks

The integration shape is identical; only the adapter import changes.

**x402:**

- [Express](https://github.com/inflowpayai/inflow-node/tree/main/examples/x402-seller-express)
- [Hono](https://github.com/inflowpayai/inflow-node/tree/main/examples/x402-seller-hono)
- [Fastify](https://github.com/inflowpayai/inflow-node/tree/main/examples/x402-seller-fastify) — note
  `paymentMiddlewareFromConfig` mutates the Fastify instance in place rather than returning a middleware.
- [Next 16](https://github.com/inflowpayai/inflow-node/tree/main/examples/x402-seller-next) — uses a root-level
  `proxy.ts` with `paymentProxyFromConfig`.
- Package reference:
  [`@inflowpayai/x402-seller`](https://github.com/inflowpayai/inflow-node/tree/main/packages/x402-seller)

**MPP:**

- [Express](https://github.com/inflowpayai/inflow-node/tree/main/examples/mpp-seller-express)
- [Hono](https://github.com/inflowpayai/inflow-node/tree/main/examples/mpp-seller-hono)
- Package reference:
  [`@inflowpayai/mpp-seller`](https://github.com/inflowpayai/inflow-node/tree/main/packages/mpp-seller)

For the full reference — schemes and rails, price formats, multiple facilitators, error handling, and extensions — see
**[seller-reference.md](./seller-reference.md)**.
