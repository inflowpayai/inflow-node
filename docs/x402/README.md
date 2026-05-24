# InFlow x402 SDK

InFlow's Node.js SDK for the [x402 protocol](https://docs.x402.org). Add InFlow to your existing foundation V2 middleware as a facilitator,
generate your route's `accepts[]` from your seller config, and accept or make x402 payments — InFlow balance transfers, on-chain exact-amount
transfers, and (forthcoming) instrument-based payments.

## Packages

| Package                                                  | Role                                                         | Install when…                                      |
| -------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| [`@inflowpayai/x402`](../../packages/x402)               | Core types + HTTP client                                     | Rarely installed directly.                         |
| [`@inflowpayai/x402-seller`](../../packages/x402-seller) | Facilitator client + seller client + `inflowAccepts` helper  | Accepting x402 payments as a seller.               |
| [`@inflowpayai/x402-buyer`](../../packages/x402-buyer)   | `InflowClient` — foundation `x402Client` subclass for buyers | Paying via x402, with or without on-chain signers. |

All packages publish under the `@inflowpayai` scope and depend on `@x402/core@^2.12.0` as a peer.

The SDK does **not** ship a seller middleware. Sellers use the foundation V2 middleware (`paymentMiddlewareFromConfig` from
`@x402/express`, `@x402/hono`, `@x402/fastify`, or `@x402/next`) directly and pass the InFlow facilitator into its `facilitatorClients`
array. See [architecture.md](./architecture.md) for the rationale.

## Quickstart — seller (Express)

```bash
pnpm add @inflowpayai/x402-seller @x402/express @x402/core express
```

```ts
import { paymentMiddlewareFromConfig } from '@x402/express';
import express from 'express';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '@inflowpayai/x402-seller';

const apiKey = process.env.INFLOW_API_KEY!;
const inflow = createInflowFacilitator({ environment: 'sandbox', apiKey });
const client = await createInflowSellerClient({ environment: 'sandbox', apiKey });

const app = express();
app.use(express.json());
app.use(
  paymentMiddlewareFromConfig(
    {
      'GET /api/widgets': {
        accepts: await inflowAccepts(client, { price: '$0.01' }),
      },
      'POST /api/upload': {
        accepts: await inflowAccepts(client, {
          price: '0.10 USDC',
          schemes: ['balance', 'exact'],
        }),
      },
    },
    [inflow],
    await inflowSchemeRegistrations(client),
  ),
);
app.get('/api/widgets', (_req, res) => res.json({ widgets: [1, 2, 3] }));
app.listen(3000);
```

For Hono, swap `@x402/express` for `@x402/hono`; everything else is the same. For Fastify, use `@x402/fastify` — its
`paymentMiddlewareFromConfig` mutates the Fastify instance in place rather than returning a middleware function (`paymentMiddlewareFromConfig(app, routes, [inflow], await inflowSchemeRegistrations(client))`).
For Next 16, use `@x402/next`'s `paymentProxyFromConfig` from a root-level `proxy.ts` file (Next 16 renamed the convention from `middleware.ts`);
see [`examples/x402-seller-next`](../../examples/x402-seller-next) for the complete shape including the `proxy.ts` placement, route-handler structure, and the
required `next` pin (`~16.0.10`, to match `@x402/next@2.12.0`'s peer range).

The pieces:

- `createInflowFacilitator` returns a foundation `FacilitatorClient` (`verify` / `settle` / `getSupported`). Drops into
  `paymentMiddlewareFromConfig`'s `facilitatorClients` array. Authed — `apiKey` is required at the type level.
- `createUnauthenticatedInflowFacilitator` is the explicit escape hatch for facilitator-only deployments (self-hosted, public-facilitator
  mode, test harnesses).
- `createInflowSellerClient` owns the seller-authed `/v1/x402/config` endpoint plus signer-address discovery. Drives `inflowAccepts`. Async
  factory — primes its caches in parallel before resolving.
- `inflowAccepts(client, options)` expands the seller's config into foundation `PaymentOption[]` (asset contract + atomic amount pre-
  resolved). Splat into a route's `accepts` array.
- `inflowSchemeRegistrations(client)` returns the passthrough `SchemeRegistration[]` covering every `(scheme, network)` the seller's
  config can emit. Pass as the third arg to `paymentMiddlewareFromConfig`; the foundation refuses to boot otherwise.

## Quickstart — buyer (`fetch`)

```bash
pnpm add @inflowpayai/x402-buyer @x402/core
```

```ts
import { createInflowClient } from '@inflowpayai/x402-buyer';
import { x402HTTPClient } from '@x402/core/client';

const core = await createInflowClient({
  apiKey: process.env.INFLOW_API_KEY!,
  environment: 'sandbox',
});
const http = new x402HTTPClient(core);

const initial = await fetch('https://api.example.com/widgets');
if (initial.status === 402) {
  const paymentRequired = http.getPaymentRequiredResponse((n) => initial.headers.get(n));
  const paymentPayload = await http.createPaymentPayload(paymentRequired);
  const paymentHeaders = http.encodePaymentSignatureHeader(paymentPayload);
  const paid = await fetch('https://api.example.com/widgets', { headers: paymentHeaders });
  const result = await http.processResponse(paid);
  if (result.kind === 'success') {
    console.log(result.body);
  }
}
```

`InflowClient` extends `@x402/core`'s `x402Client`, so foundation registration helpers slot in directly when the buyer wants to pay
non-InFlow networks as well:

```ts
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';

registerExactEvmScheme(core, { signer: evmAccount, networks: ['eip155:1'] });
registerExactSvmScheme(core, { signer: svmKeypair, networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] });
```

When the seller's 402 offers a requirement InFlow can sign (`balance/inflow:1`, or any `(scheme, network)` advertised by the buyer
capability cache), the InFlow path wins. Otherwise the foundation's selector routes to whatever EVM or SVM scheme the caller registered
above — same client, two paths.

## Multi-facilitator setup

```ts
paymentMiddlewareFromConfig(
  {
    /* routes */
  },
  [
    inflow,
    cdp, // e.g. Coinbase CDP facilitator
    polygon, // any other FacilitatorClient
  ],
);
```

First claimer in the `facilitatorClients` array of a `(scheme, network)` pair (via `getSupported()`) wins verify/settle routing — that's the
foundation's `x402ResourceServer.initialize()` contract. Order the array intentionally; subsequent claimers are silently ignored.

On the buyer side, `InflowClient` enforces a fixed precedence instead: the InFlow buyer capability cache is consulted first, and only the
foundation's registered schemes get a turn when nothing matches. This mirrors the seller-side rule that an InFlow facilitator placed
first wins on its claimed pairs.

## Schemes

The SDK supports three payment schemes:

- **`balance`** — InFlow-internal ledger transfer between two InFlow accounts. No on-chain transaction, no gas. The fastest path; uses the
  literal `'inflow:1'` network identifier.
- **`exact`** — on-chain transfer signed via EIP-3009 or Permit2 (EVM) or the chain-specific signing method (Solana, Aptos, Stellar). Uses
  CAIP-2 network identifiers — `eip155:<chainId>` for EVM (e.g. `eip155:8453`); for Solana, the spec-strict
  `solana:<first-32-base58-chars-of-genesis-hash>` (e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` for mainnet).
- **`instrument`** — reserved. The value is in the type union for forward compatibility; `inflowAccepts` passes it through unchanged if a
  server ever publishes it, but end-to-end settlement support is not yet enabled.

See [protocol-mapping.md](./protocol-mapping.md) for how each scheme maps to the on-the-wire `PaymentRequirements` / `PaymentOption` shapes.

## Extensions

The `payment-identifier` extension is supported end-to-end. The SDK validates the format client-side; callers opt in with their own ID via
`SignOptions.paymentId` on `prepareInflowPayment`. New extensions plug in as single-file handlers — see [extensions.md](./extensions.md).

Per-route extension declarations live on `RouteConfig.extensions` (foundation middleware). Facilitator-wide declarations come from each
`FacilitatorClient.getSupported().extensions` and are merged by the middleware automatically.

## Deeper reading

- [architecture.md](./architecture.md) — what the SDK contributes vs. what the foundation owns, conflict precedence, request lifecycle.
- [protocol-mapping.md](./protocol-mapping.md) — InFlow ↔ wire types, network identifier rules, decimal sourcing.
- [extensions.md](./extensions.md) — the `payment-identifier` extension and the handler contract for new extensions.

For monorepo-level docs (publishing, contributing, tooling), see [../monorepo](../monorepo).

## License

MIT.
