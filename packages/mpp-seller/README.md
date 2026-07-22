# @inflowpayai/mpp-seller

Seller-side InFlow MPP methods for [`mppx`](https://www.npmjs.com/package/mppx). Add them to `Mppx.create`, and
`charge()` returns a `402` payment challenge for unpaid requests and verifies + settles payments through InFlow. This
attaches `Method.toServer` behaviour to shared methods from `@inflowpayai/mpp`; the foundation `mppx` SDK owns the wire
mechanics (challenge minting + HMAC binding).

## Install

```sh
pnpm add @inflowpayai/mpp-seller mppx
```

`mppx` is a peer dependency.

## What's exported

- `inflow(parameters)` — the seller `inflow` method. Pass it to
  `Mppx.create({ methods: [inflow({ apiKey })], secretKey })`. Its `verify` redeems and settles the submitted credential
  through InFlow (`POST /v1/mpp/redeem`).
- `tempo(parameters)` — the seller `tempo` method for Tempo TIP-20 charges. Pass it to
  `Mppx.create({ methods: [tempo({ apiKey, currency, recipient })], secretKey })`. Fee-payer sponsorship defaults to
  off; set `methodDetails.feePayer: true` (on the method or per charge) to mint a sponsored challenge.
- `inflowCharges(mppx, prices)` — present several currencies on one route. Returns the Web-fetch handler from
  `compose(...)`: one `WWW-Authenticate` challenge per price (the MPP analog of `@inflowpayai/x402-seller`'s
  `inflowAccepts`). See [Multiple currencies](#multiple-currencies) below.
- `inflowChargesNodeListener(mppx, prices)` — the same, wrapped with `Mppx.toNodeListener` so it mounts directly on a
  Node `http` server (or an Express route).
- `createConfigClient(client)` — exposes the `GET /v1/mpp/config` loader directly, to prime or inspect the currency→rail
  capability map yourself. Returns an `InflowConfigClient`.
- `Mppx` and `Expires` (re-exported from `mppx/server`) and `Receipt` (from `mppx`) — a single import gives the
  foundation server handler and the InFlow methods.
- Types: `InflowSellerParameters`, `TempoSellerParameters`, `LoadedConfig`, `InflowChargePrice`, plus the core
  re-exports `Environment`, `MppCurrencyRail`, `MppProblemDetail`, `MppReceipt`.
- Errors: `MppUnsupportedCurrencyError` (charge currency has no rail in the PSP config), `MppRedeemProblemError`
  (redemption failed; carries the PSP's RFC 9457 problem).

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
  methods: [inflow({ apiKey: process.env.INFLOW_API_KEY!, environment: 'sandbox' })],
  secretKey: process.env.MPP_SECRET_KEY,
});

export async function handler(req: Request) {
  const r = await mppx.charge({ amount: '0.01', currency: 'USDC' })(req);
  if (r.status === 402) return r.challenge;
  return r.withReceipt(Response.json({ data: '…' }));
}
```

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

## See also

- [@inflowpayai/mpp](../mpp) — core MPP `Method` definitions, wire types, codec, HTTP client
- [Product overview](../../docs/mpp/README.md)
- [Architecture](../../docs/mpp/architecture.md) — InFlow-as-PSP boundary, package layering
- Examples: [`mpp-seller-express`](../../examples/mpp-seller-express),
  [`mpp-seller-hono`](../../examples/mpp-seller-hono)

## License

MIT
