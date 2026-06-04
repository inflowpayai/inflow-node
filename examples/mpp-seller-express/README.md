# Example — MPP seller on Express

A minimal Express app that accepts MPP payments via InFlow. Uses `mppx`'s own Express adapter (`Mppx` from
`mppx/express`) with InFlow's `inflow` seller method. `Mppx.create` mints and HMAC-binds the challenge locally with
`secretKey`; the `inflow` method's `verify` redeems and settles through the InFlow PSP.

## Run

```bash
cp .env.example .env
# fill in INFLOW_API_KEY from your sandbox account, and set MPP_SECRET_KEY (see the mppx docs)
pnpm install
pnpm dev
```

The server listens on `http://localhost:3000` and serves these routes:

| Route               | Price                      | Notes                                                                           |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/widgets`  | `0.01 USDC`                | Single currency via the Express adapter's `charge`. Crypto → `balance` rail.    |
| `POST /api/upload`  | `0.10 USDC`                | Single currency via `charge`. Crypto → `balance` rail.                          |
| `GET /api/checkout` | `1.0 USD` or `0.0095 USDC` | Multi-currency: one challenge per price (USD → `instrument`, USDC → `balance`). |
| `GET /free`         | —                          | Not gated; passes through.                                                      |

The Express adapter (`mppx/express`) exposes only the single-currency `charge` — it strips `compose`. The multi-currency
`GET /api/checkout` route therefore runs on a second, core `mppx/server` instance (`core`, sharing the same method +
`secretKey`), bridged into Express with InFlow's `inflowChargesNodeListener` helper.

Hit it with the matching buyer example or any other MPP client:

```bash
cd ../mpp-buyer-fetch
INFLOW_API_KEY=$INFLOW_API_KEY TARGET_URL=http://localhost:3000/api/widgets pnpm start
```
