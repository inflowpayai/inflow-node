# Example — x402 seller on Fastify

A minimal Fastify app that accepts x402 payments via InFlow. Uses the foundation V2 middleware (`paymentMiddlewareFromConfig` from
`@x402/fastify`) with InFlow's facilitator client + seller client + `inflowAccepts` helper. `@x402/fastify` mutates the Fastify
instance in place rather than returning a middleware function — that's the only shape difference from the Express and Hono variants.

## Run

```bash
cp .env.example .env
# fill in INFLOW_API_KEY from your sandbox account
pnpm install
pnpm dev
```

The server listens on `http://localhost:3000` and serves three routes:

| Route              | Price       | Notes                          |
| ------------------ | ----------- | ------------------------------ |
| `GET /api/widgets` | `$0.01`     | Exact scheme only.             |
| `POST /api/upload` | `0.10 USDC` | Balance + exact schemes only.  |
| `GET /free`        | —           | Not protected; passes through. |

Hit it with the matching buyer example:

```bash
cd ../x402-buyer-fetch
INFLOW_API_KEY=$INFLOW_API_KEY TARGET_URL=http://localhost:3000/api/widgets pnpm start
```
