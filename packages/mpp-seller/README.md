# @inflowpayai/mpp-seller

Seller-side InFlow MPP `inflow` method for [`mppx`](https://www.npmjs.com/package/mppx). Add it to `Mppx.create`, and
`charge()` returns a `402` payment challenge for unpaid requests and verifies + settles payments through InFlow.

## Install

```sh
pnpm add @inflowpayai/mpp-seller mppx
```

`mppx` is a peer dependency.

## Configuration

Two InFlow-issued values, both read from the environment:

- `apiKey` → `inflow({ apiKey })` — authenticates the InFlow REST calls.
- `secretKey` → `Mppx.create({ secretKey })` (or the `MPP_SECRET_KEY` env var) — an InFlow-issued secret, provisioned
  out of band and separate from the API key.

## Rails — derived from the charge currency

The rail is determined by the charge currency, using the server-authoritative map from `GET /v1/mpp/config`:

| Charge currency          | Rail         | Result                                               |
| ------------------------ | ------------ | ---------------------------------------------------- |
| Crypto (e.g. `USDC`)     | `balance`    | one challenge; no extra params                       |
| Fiat (e.g. `USD`)        | `instrument` | one challenge; `methodDetails.instrumentId` optional |
| Unsupported (e.g. `JPY`) | —            | `MppUnsupportedCurrencyError`                        |

The capability map is fetched once and cached at startup. `createConfigClient` (exported alongside `inflow`) exposes
that loader directly, if you want to prime or inspect the config yourself.

## Usage

### Manual mode (Fetch API)

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

### Hono

```ts
import { Hono } from 'hono';
import { Mppx } from 'mppx/hono';
import { inflow } from '@inflowpayai/mpp-seller';

const app = new Hono();
const mppx = Mppx.create({
  methods: [inflow({ apiKey: process.env.INFLOW_API_KEY!, environment: 'sandbox' })],
  secretKey: process.env.MPP_SECRET_KEY,
});

app.get('/resource', mppx.charge({ amount: '0.01', currency: 'USD', methodDetails: { instrumentId } }), (c) =>
  c.json({ data: '…' }),
);
```

This package ships no middleware of its own; use `mppx`'s (`mppx/hono`, `mppx/express`, `mppx/nextjs`, `mppx/elysia`) or
manual mode.

## Errors

- `MppUnsupportedCurrencyError` — the charge currency has no rail in the PSP config.
- `MppRedeemProblemError` — redemption failed; carries the PSP's RFC 9457 problem (the framework emits `402` + that
  body).
- `MppProtocolVersionError` — the PSP's protocol/SDK version floor is incompatible with this SDK.

## Notes

Fiat (`instrument`) settlement is not yet live: a fiat charge produces a valid challenge but redemption returns a "not
yet available" problem until instrument settlement ships.

## License

MIT
