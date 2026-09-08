# @inflowpayai/x402-seller

Seller-side InFlow primitives that plug into the foundation V2 middleware for Express, Fastify, Hono, and Next.js. This
package does **not** ship middleware itself — sellers use those adapters directly and pass InFlow's facilitator client
into the adapter's `facilitatorClients` argument.

## Install

```bash
pnpm add @inflowpayai/x402-seller @x402/express @x402/core @x402/extensions
# …or @x402/fastify, @x402/hono, or @x402/next in place of @x402/express
```

`@inflowpayai/x402` is a runtime dependency; `@x402/core` and `@x402/extensions` are peer dependencies.

## Payment response caching

The foundation middleware owns payment response headers. Foundation 2.22.0 is the supported floor and emits
`Cache-Control: no-store` for unpaid challenges, Permit2 allowance responses, and settlement failures. Successful
responses carrying `PAYMENT-RESPONSE` use `private`; the Express, Fastify, Hono, and Next.js route-handler integrations
preserve existing handler cache directives. The Next.js proxy marks the settled `NextResponse.next()` continuation as
`private`; Next.js owns the subsequent merge with the route response.

## Seller Account

This package requires an InFlow **Seller** account and an API key created in its dashboard:

- [Sandbox registration](https://sandbox.inflowpay.ai) for testing
- [Production registration](https://app.inflowpay.ai) for live payments

`environment` must match the dashboard that issued the key. A Developer account key is valid InFlow authentication but
cannot load Seller configuration; `createInflowSellerClient()` rejects with an `InflowApiError` whose code is
`SELLER_ACCOUNT_REQUIRED`.

## What's exported

- `createInflowFacilitator(options)` — synchronous factory. Returns a foundation `FacilitatorClient` (`verify` /
  `settle` / `getSupported`). `options.apiKey` is required at the type level so an env-var omission can't silently
  degrade to facilitator-mode.
- `createUnauthenticatedInflowFacilitator(options)` — sibling factory returning the same `FacilitatorClient` shape but
  sending no `X-API-KEY` header. The explicit escape hatch for facilitator-only deployments (self-hosted,
  public-facilitator mode, test harnesses).
- `createInflowSellerClient(options)` — async factory. Returns an `InflowSellerClient` (`config` / `refreshConfig` /
  `refreshSupported` / `getSignerAddresses`). Primes the config + supported caches in parallel before resolving;
  60-minute TTL.
- `inflowAccepts(client, options)` — async helper. Returns a foundation `PaymentOption[]` ready to splat into a route's
  `accepts` field. The prices are pre-resolved to `AssetAmount` form (asset contract address + atomic-unit amount).
- `inflowRoute(client, options)` — builds `accepts` and compatible EIP-2612 sponsorship declarations. See below for explicit Permit2 selection.
- `inflowSchemeRegistrations(client)` — async helper. Reads the seller's `/v1/x402/config` and returns one passthrough
  `SchemeRegistration` per `(scheme, network)` pair the server can emit, with authorization-only payment flows for the
  exact asset transfer methods declared by config. Pass these through the adapter's `schemes` argument; the foundation
  refuses to boot without registrations covering every advertised scheme.
- `X402PriceParseError` — typed error thrown by `inflowAccepts` when a price string doesn't parse.

### Price formats

`PriceSpec.amount` accepts three forms (all support up to 8 decimal places):

| Form                                 | Example                                  | Resolved currency                    |
| ------------------------------------ | ---------------------------------------- | ------------------------------------ |
| `$<integer>(.<decimals>)?`           | `'$0.01'`, `'$10.00000001'`              | `USD`                                |
| `<integer>(.<decimals>)? <CURRENCY>` | `'0.01 USDC'`, `'1 USDT'`, `'0.5 PYUSD'` | from the suffix                      |
| `<integer>(.<decimals>)?` (bare)     | `'0.01'`                                 | from `PriceSpec.currency` (required) |

If both `amount` and `currency` carry a currency and they disagree, the `currency` field wins. `'USD'` is a wildcard
that matches any stablecoin asset the seller has configured.

## Quickstart

```ts
import { paymentMiddlewareFromConfig } from '@x402/express';
import express from 'express';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '@inflowpayai/x402-seller';

const apiKey = process.env['INFLOW_API_KEY'];
if (!apiKey) throw new Error('Set INFLOW_API_KEY');
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
app.listen(3000);
```

## Gasless Permit2 approval for external wallets

Use `inflowRoute` when an external-wallet buyer needs an EIP-2612 permit bundled atomically with settlement. It checks
the seller's token metadata and refreshes facilitator support before declaring sponsorship. The configured token must
explicitly support EIP-2612, provide its signing domain, and use the canonical Permit2 proxy. InFlow-managed buyers
cannot sign Permit2 payments; they can use a separate balance or EIP-3009 offer.

```ts
import { inflowRoute } from '@inflowpayai/x402-seller';

const sponsoredRoute = await inflowRoute(client, {
  price: '0.01 USDC',
  schemes: ['exact'],
  networks: ['eip155:84532'],
  assetTransferMethod: 'permit2',
});
// Pass sponsoredRoute directly as the route value in paymentMiddlewareFromConfig.
```

Without `assetTransferMethod`, offers retain the server-configured defaults. Explicit Permit2 selection omits on-chain
assets without a configured canonical proxy; balance offers are unaffected. `inflowSchemeRegistrations` registers the
configured Permit2 alternative without adding it to ordinary `inflowAccepts` offers.

Declarations apply to a whole route. If any Permit2 offer lacks EIP-2612 capability, the route omits EIP-2612 sponsorship;
use separate routes or a currency filter for incompatible tokens. Missing metadata or facilitator support never implies
sponsorship. The helper does not declare ERC-20 approval batching.

Pass the matching InFlow facilitator first in the middleware's facilitator list for sponsored routes. The helper checks
that client's capabilities, not the middleware's final routing: an earlier facilitator claiming the same pair takes
precedence even if it cannot sponsor approval.

External buyers register the foundation `@x402/evm/exact/client` scheme. Foundation 2.22.0 signs the permit when the
declaration is present and allowance is insufficient. Supply the matching chain's `schemeOptions.rpcUrl` for nonce and
allowance reads. Do not attach external permit signatures to an InFlow-generated treasury payload.

## Multi-facilitator

Pass multiple facilitator clients in the array — first claimer of a `(scheme, network)` pair via `getSupported()` wins
routing (foundation's declaration-order resolution):

```ts
paymentMiddlewareFromConfig({/* routes */}, [
  inflow, // claims (balance, inflow), (exact, eip155:8453), …
  cdp, // claims whatever inflow doesn't
  partnerFacilitator,
]);
```

## See also

- [@inflowpayai/x402](../x402) — protocol types, HTTP client, constants
- [Product overview](../../docs/x402/README.md)
- [Architecture](../../docs/x402/architecture.md) — InFlow vs. foundation responsibilities, `inflowAccepts` algorithm,
  conflict precedence
- [Wire-format mapping](../../docs/x402/protocol-mapping.md) — types, headers, network rules, price formats

## License

MIT.
