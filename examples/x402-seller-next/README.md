# Example — x402 seller on Next 16

A minimal Next 16 App Router app that accepts x402 payments via InFlow. Uses the foundation V2 proxy
(`paymentProxyFromConfig` from `@x402/next`) with InFlow's facilitator client + seller client + `inflowAccepts` helper.
The InFlow setup lives at module top in `proxy.ts` so `await createInflowSellerClient(...)` primes its caches once at
the cold-start boundary.

Next 16 only — `@x402/next@2.12.0`'s peer dep is `next >=16.0.10 <16.1.0`. There is no 14/15 adapter. The file
convention is `proxy.ts` (renamed from `middleware.ts` in Next 16); the export is `const proxy`, not `const middleware`.

## Run

```bash
cp .env.example .env
# fill in INFLOW_API_KEY from your sandbox account
pnpm install
pnpm dev
```

The server listens on `http://localhost:3000` and serves three routes:

| Route              | Price       | Notes                                 |
| ------------------ | ----------- | ------------------------------------- |
| `GET /api/widgets` | `$0.01`     | Exact scheme only.                    |
| `POST /api/upload` | `0.10 USDC` | Balance + exact schemes only.         |
| `GET /free`        | —           | Not matched by proxy; passes through. |

Hit it with the matching buyer example:

```bash
cd ../x402-buyer-fetch
INFLOW_API_KEY=$INFLOW_API_KEY TARGET_URL=http://localhost:3000/api/widgets pnpm start
```

## Layout

```
proxy.ts                   # paymentProxyFromConfig — InFlow wiring lives here
app/api/widgets/route.ts   # plain Route Handler, no x402 code
app/api/upload/route.ts    # plain Route Handler, no x402 code
app/free/route.ts          # plain Route Handler, not protected
```

Next 16's `proxy.ts` always runs on the Node.js runtime; no route-segment `config` export is needed (or allowed). The
proxy dispatches by matching the request against the `routes` keys passed to `paymentProxyFromConfig`, so `/free` —
which is not in that map — passes through to its Route Handler untouched.
