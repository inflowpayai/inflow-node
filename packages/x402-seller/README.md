# @inflowpayai/x402-seller

Seller-side InFlow primitives that plug into the foundation V2 middleware (`paymentMiddlewareFromConfig` from `@x402/express` or
`@x402/hono`). This package does **not** ship a middleware itself — sellers use the foundation's directly and pass InFlow's facilitator
client into its `facilitatorClients` array.

## Install

```bash
pnpm add @inflowpayai/x402-seller @x402/express @x402/core
# …or @x402/hono in place of @x402/express
```

`@inflowpayai/x402` is a runtime dependency (bundled via workspace); `@x402/core` is a peer dependency.

## What's exported

- `createInflowFacilitator(options)` — synchronous factory. Returns a foundation `FacilitatorClient` (`verify` / `settle` /
  `getSupported`). `options.apiKey` is required at the type level so an env-var omission can't silently degrade to facilitator-mode.
- `createUnauthenticatedInflowFacilitator(options)` — sibling factory returning the same `FacilitatorClient` shape but sending no
  `X-API-KEY` header. The explicit escape hatch for facilitator-only deployments (self-hosted, public-facilitator mode, test harnesses).
- `createInflowSellerClient(options)` — async factory. Returns an `InflowSellerClient` (`config` / `refreshConfig` / `refreshSupported`
  / `getSignerAddresses`). Primes the config + supported caches in parallel before resolving; 60-minute TTL.
- `inflowAccepts(client, options)` — async helper. Returns a foundation `PaymentOption[]` ready to splat into a route's `accepts` field. The
  prices are pre-resolved to `AssetAmount` form (asset contract address + atomic-unit amount).
- `inflowSchemeRegistrations(client)` — async helper. Reads the seller's `/v1/x402/config` and returns one passthrough
  `SchemeRegistration` per `(scheme, network)` pair the server can emit. Pass these as the third argument to
  `paymentMiddlewareFromConfig`; the foundation refuses to boot without registrations covering every advertised scheme.
- `X402PriceParseError` — typed error thrown by `inflowAccepts` when a price string doesn't parse.

### Price formats

`PriceSpec.amount` accepts three forms (all support up to 8 decimal places):

| Form                                 | Example                                  | Resolved currency                    |
| ------------------------------------ | ---------------------------------------- | ------------------------------------ |
| `$<integer>(.<decimals>)?`           | `'$0.01'`, `'$10.00000001'`              | `USD`                                |
| `<integer>(.<decimals>)? <CURRENCY>` | `'0.01 USDC'`, `'1 USDT'`, `'0.5 PYUSD'` | from the suffix                      |
| `<integer>(.<decimals>)?` (bare)     | `'0.01'`                                 | from `PriceSpec.currency` (required) |

If both `amount` and `currency` carry a currency and they disagree, the `currency` field wins. `'USD'` is a wildcard that matches any
stablecoin asset the seller has configured.

## Quickstart

```ts
import { paymentMiddlewareFromConfig } from '@x402/express';
import express from 'express';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
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
    [...(await inflowSchemeRegistrations(client)), registerExactEvmScheme()],
  ),
);
app.listen(3000);
```

## Multi-facilitator

Pass multiple facilitator clients in the array — first claimer of a `(scheme, network)` pair via `getSupported()` wins routing (foundation's
declaration-order resolution):

```ts
paymentMiddlewareFromConfig(
  {
    /* routes */
  },
  [
    inflow, // claims (balance, inflow), (exact, eip155:8453), …
    cdp, // claims whatever inflow doesn't
    partnerFacilitator,
  ],
);
```

## See also

- [@inflowpayai/x402](../x402) — protocol types, HTTP client, constants
- [Product overview](../../docs/x402/README.md)
- [Architecture](../../docs/x402/architecture.md) — InFlow vs. foundation responsibilities, `inflowAccepts` algorithm, conflict precedence
- [Wire-format mapping](../../docs/x402/protocol-mapping.md) — types, headers, network rules, price formats

## License

MIT.
