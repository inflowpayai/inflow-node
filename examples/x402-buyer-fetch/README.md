# Example — `@inflowpayai/x402-buyer-fetch`

A minimal script that pays for a protected resource via `fetch`.

## Run

Start one of the seller examples first (`examples/x402-seller-express` or `examples/x402-seller-hono`), then in another terminal:

```bash
cp .env.example .env
# fill in INFLOW_API_KEY from your sandbox account
pnpm install
pnpm start
```

Default target is `http://localhost:3000/api/widgets`. Override with `TARGET_URL=...` in `.env`.

Output looks like:

```
GET http://localhost:3000/api/widgets
  status: 200
  body: {"widgets":[1,2,3]}
  paid via inflow:1, tx 0xtxhash
```
