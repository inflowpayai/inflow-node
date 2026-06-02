# @inflowpayai/mpp-seller

Seller-side InFlow MPP `inflow` method for [`mppx`](https://www.npmjs.com/package/mppx). Add it to `Mppx.create`, and
`charge()` returns a `402` payment challenge for unpaid requests and verifies + settles payments through InFlow. This
attaches `Method.toServer` behaviour to the shared `inflow` method from `@inflowpayai/mpp`; the foundation `mppx` SDK
owns the wire mechanics (challenge minting + HMAC binding).

## Install

```sh
pnpm add @inflowpayai/mpp-seller mppx
```

`mppx` is a peer dependency.

## What's exported

- `inflow(parameters)` — the seller `inflow` method. Pass it to
  `Mppx.create({ methods: [inflow({ apiKey })], secretKey })`. Its `verify` redeems and settles the submitted credential
  through InFlow (`POST /v1/mpp/redeem`).
- `createConfigClient(client)` — exposes the `GET /v1/mpp/config` loader directly, to prime or inspect the currency→rail
  capability map yourself. Returns an `InflowConfigClient`.
- `Mppx` and `Expires` (re-exported from `mppx/server`) and `Receipt` (from `mppx`) — a single import gives the
  foundation server handler and the InFlow method.
- Types: `InflowSellerParameters`, `LoadedConfig`, plus the core re-exports `Environment`, `MppCurrencyRail`,
  `MppProblemDetail`, `MppReceipt`.
- Errors: `MppUnsupportedCurrencyError` (charge currency has no rail in the PSP config), `MppRedeemProblemError`
  (redemption failed; carries the PSP's RFC 9457 problem).

## Configuration

- `apiKey` → `inflow({ apiKey })` — your InFlow API key; authenticates the InFlow REST calls.

`Mppx.create` additionally takes a `secretKey` (or the `MPP_SECRET_KEY` env var); see the
[`mppx`](https://github.com/wevm/mppx) docs for what it is and how it's used.

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

## See also

- [@inflowpayai/mpp](../mpp) — core `inflow` `Method` definition, wire types, codec, HTTP client
- [Product overview](../../docs/mpp/README.md)
- [Architecture](../../docs/mpp/architecture.md) — InFlow-as-PSP boundary, package layering
- Examples: [`mpp-seller-express`](../../examples/mpp-seller-express),
  [`mpp-seller-hono`](../../examples/mpp-seller-hono)

## License

MIT
