# Example — `@inflowpayai/mpp-buyer` with transparent `fetch`

A minimal script that pays for a protected resource through a polyfilled global `fetch`. `Mppx.create` replaces
`globalThis.fetch` with a payment-aware wrapper, so a `402` is handled transparently — no per-call wiring.

## Run

Start one of the seller examples first (`examples/mpp-seller-express` or `examples/mpp-seller-hono`), then in another
terminal:

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
  paid via inflow: 86f75793-abeb-4fe6-9a46-61901be77070
```

For the explicit, non-polyfill path (`mppx.fetch`), see [`../mpp-buyer-manual`](../mpp-buyer-manual).
