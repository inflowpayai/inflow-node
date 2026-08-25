# Example — MPP seller on Hono

A minimal Hono app that accepts MPP payments via InFlow. Uses `mppx`'s own Hono adapter (`Mppx` from `mppx/hono`) with
InFlow's `inflow` seller method, served on Node via `@hono/node-server`. `Mppx.create` mints and HMAC-binds the
challenge locally with `secretKey`; the `inflow` method's `verify` redeems and settles through the InFlow PSP.

## Prerequisite

This example requires an InFlow **Seller** account and an API key created in its dashboard:

- [Sandbox registration](https://sandbox.inflowpay.ai) for testing
- [Production registration](https://app.inflowpay.ai) for live payments

A Developer account is a different API role and cannot be used in place of a Seller account for this example.

## Run

```bash
cp .env.example .env
# fill in INFLOW_API_KEY from your sandbox account, and set MPP_SECRET_KEY (see the mppx docs)
pnpm install
pnpm dev
```

The server listens on `http://localhost:3000` and serves these routes:

| Route                | Price                      | Notes                                                                           |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/widgets`   | `0.01 USDC`                | Single currency via the Hono adapter's `charge`. Crypto → `balance` rail.       |
| `POST /api/upload`   | `0.10 USDC`                | Single currency via `charge`. Crypto → `balance` rail.                          |
| `GET /api/subscribe` | `1.00 USDC` monthly        | Recurring subscription on the `balance` rail.                                   |
| `GET /api/checkout`  | `1.0 USD` or `0.0095 USDC` | Multi-currency: one challenge per price (USD → `instrument`, USDC → `balance`). |
| `GET /free`          | —                          | Not gated; passes through.                                                      |

The Hono adapter (`mppx/hono`) exposes only the single-currency `charge` — it strips `compose`. The multi-currency
`GET /api/checkout` and `GET /api/subscribe` therefore use core `mppx/server` instances; Hono drives the InFlow
Web-fetch handlers directly from `c.req.raw`.

Hit it with the matching buyer example:

```bash
cd ../mpp-buyer-manual
INFLOW_API_KEY=$INFLOW_API_KEY TARGET_URL=http://localhost:3000/api/widgets pnpm start
```
