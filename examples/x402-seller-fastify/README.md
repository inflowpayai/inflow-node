# Example — x402 seller on Fastify

A minimal Fastify app that accepts x402 payments via InFlow. Uses the foundation V2 middleware
(`paymentMiddlewareFromHTTPServer` from `@x402/fastify`) with InFlow's request-time routes and `inflowAccepts` helper.
Prices use query parameters: Fastify's payment hook runs before body parsing, leaving the body for the route handler.

## Prerequisite

This example requires an InFlow **Seller** account and an API key created in its dashboard:

- [Sandbox registration](https://sandbox.inflowpay.ai) for testing
- [Production registration](https://app.inflowpay.ai) for live payments

A Developer account is a different API role and cannot be used in place of a Seller account for this example.

## Run

```bash
cp .env.example .env
# fill in INFLOW_API_KEY from your sandbox account
pnpm install
pnpm dev
```

The server listens on `http://localhost:3000` and serves three routes:

| Route              | Price                                      | Notes                          |
| ------------------ | ------------------------------------------ | ------------------------------ |
| `GET /api/widgets` | `$0.01`; `?tier=premium`: `$0.02`          | Exact scheme only.             |
| `POST /api/upload` | `0.10 USDC`; `?priority=high`: `0.20 USDC` | Balance + exact schemes only.  |
| `GET /free`        | —                                          | Not protected; passes through. |

Hit it with the matching buyer example:

```bash
cd ../x402-buyer-fetch
INFLOW_API_KEY=$INFLOW_API_KEY TARGET_URL=http://localhost:3000/api/widgets pnpm start
```
