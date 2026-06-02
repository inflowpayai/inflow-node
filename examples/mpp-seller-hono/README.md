# Example — MPP seller on Hono

A minimal Hono app that accepts MPP payments via InFlow. Uses `mppx`'s own Hono adapter (`Mppx` from `mppx/hono`) with
InFlow's `inflow` seller method, served on Node via `@hono/node-server`. `Mppx.create` mints and HMAC-binds the
challenge locally with `secretKey`; the `inflow` method's `verify` redeems and settles through the InFlow PSP.

## Run

```bash
cp .env.example .env
# fill in INFLOW_API_KEY from your sandbox account, and set MPP_SECRET_KEY (see the mppx docs)
pnpm install
pnpm dev
```

The server listens on `http://localhost:3000` and serves three routes:

| Route              | Price       | Notes                             |
| ------------------ | ----------- | --------------------------------- |
| `GET /api/widgets` | `0.01 USDC` | Crypto currency → `balance` rail. |
| `POST /api/upload` | `0.10 USDC` | Crypto currency → `balance` rail. |
| `GET /free`        | —           | Not gated; passes through.        |

Hit it with the matching buyer example:

```bash
cd ../mpp-buyer-manual
INFLOW_API_KEY=$INFLOW_API_KEY TARGET_URL=http://localhost:3000/api/widgets pnpm start
```
