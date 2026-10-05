# @inflowpayai/x402-seller

Seller-side InFlow primitives that plug into the foundation V2 middleware for Express, Fastify, Hono, and Next.js. This
package uses those foundation adapters directly and passes InFlow's facilitator client into their `facilitatorClients`
argument. The optional `@inflowpayai/x402-seller/express` entry point adds durable HTTP response replay around the
foundation Express middleware.

## Foundation compatibility

Use foundation 2.27.0 for Express, Hono, and Next.js. The published Fastify adapter is 2.26.0 and depends on core
`~2.26.0`; it does not include the 2.27.0 encoded-path route fix. Its upgrade remains outstanding until a compatible
adapter is published. Installing core 2.27.0 alongside Fastify does not replace Fastify's nested core dependency.

Eager middleware initialization terminates the process for permanent capability or route-configuration failures.
Register every advertised scheme/network with `inflowSchemeRegistrations`; temporary facilitator timeouts remain
retryable. Do not suppress configuration failures to start an unprotected service.

## Install

```bash
pnpm add @inflowpayai/x402-seller @x402/express @x402/core @x402/extensions
# …or @x402/fastify, @x402/hono, or @x402/next in place of @x402/express
```

`@inflowpayai/x402` is a runtime dependency; `@x402/core` and `@x402/extensions` are peer dependencies.

## Payment response caching

The foundation middleware owns payment response headers. The supported adapters emit `Cache-Control: no-store` for
unpaid challenges, Permit2 allowance responses, and settlement failures. Successful responses carrying
`PAYMENT-RESPONSE` use `private`; the Express, Fastify, Hono, and Next.js route-handler integrations preserve existing
handler cache directives. The Next.js proxy marks the settled `NextResponse.next()` continuation as `private`; Next.js
owns the subsequent merge with the route response.

## Durable Express response replay

Settlement idempotency alone does not prevent a repeated protected handler. Import `createInflowExpressReplayMiddleware`
from `@inflowpayai/x402-seller/express` when identical paid HTTP retries must return the original product and settlement
receipt without running verification, the handler, or settlement again.

Pass an existing `x402HTTPResourceServer`, an atomic durable `PaymentReplayStore`, a trusted seller/service `scope`, a
resolver for the already authenticated `principal`, and the exact captured request `body`. Mount it after
authentication, security/CORS middleware and raw-body capture, instead of a second payment middleware. Requests without
a payment header retain the ordinary foundation behavior. The helper supports authorization flows, including metered
`upto`, and bounded non-streaming responses. Request and product limits are one mebibyte each unless explicitly
configured. Mount response compression after this helper so the stored bytes correspond to the emitted content encoding.
A `grantAccess` protected-request hook can grant unpaid requests normally; payment-bearing requests that bypass
verification are rejected with HTTP 400. The body callback returns `undefined` when raw bytes were not captured.
Requests declaring a positive `Content-Length` or a `Transfer-Encoding` header require captured bytes; do not substitute
an empty buffer for missing capture. Requests supplying both `PAYMENT-SIGNATURE` and `X-PAYMENT` are rejected with
HTTP 400.

The runnable [response replay example](../../examples/x402-seller-express/src/response-replay.ts) includes a
[SQLite store](../../examples/x402-seller-express/src/replay-store.ts) with atomic claims, fenced writes, durable
product staging and completion. It requires Node 24 for `node:sqlite`; the SDK's Node 22 floor is unchanged. Set
`INFLOW_API_KEY`, `APP_AUTH_TOKEN`, and `REPLAY_DATABASE` to a database file inside a private directory, then run:

```bash
pnpm --filter @inflowpayai/example-x402-seller-express exec tsx src/response-replay.ts
```

The authenticated subject, payment envelope, actual method, canonical URL/query, raw body, and selected request headers
are bound to the identifier within the trusted seller scope. Reusing one identifier under another principal conflicts,
including while the first handler is running. `Accept`, `Accept-Language`, `Accept-Encoding` and `Content-Type` are
always included; add every application header that changes authorization or the product through `requestHeaders`.
`principal` must be a trusted application identity, not an arbitrary header or an unverified payer. Anonymous
integrations must explicitly choose a shared principal and treat possession of the exact payment payload as bearer
authorization; that is unsuitable for private personalized products.

Use the same scope and shared store across every route and service using the same seller payment-identifier namespace.
Separating them can permit concurrent handlers for one payment before either service finishes settlement. The URL
fingerprint includes Express's request protocol and `Host`. Keep these stable across retries and configure `trust proxy`
only for trusted reverse proxies; an origin change returns HTTP 409 instead of replaying the product.

Completed records replay the original status, bytes, receipt and allowed response headers. Content metadata, cache
directives, entity tags, modification times, locations and `Vary` are included; custom product headers require
`responseHeaders`. Paid responses remove a conflicting `public` cache directive while preserving the foundation's
`private` directive and other cache settings; the helper does not require `no-store`. Cookies, authentication headers,
dates, content lengths and hop-by-hop headers are excluded, including headers nominated by `Connection`. Pre-helper
security, CORS and session headers are preserved freshly on each response, never replayed from storage. Keep these out
of `responseHeaders`; that allowlist is for product metadata only. Do not depend on a paid handler to set a session
cookie. Current authentication, protected-request policy, extension validation and advertised requirements remain
checked before replay. A changed price or route requirement may reject an older payment instead of replaying it.

The store must compare fingerprints atomically, serialize claims, fence `stage`/`complete` with the claim token, and
retain records for at least 24 hours and the entire supported payment retry lifetime. It must never reclaim an unstaged
pending operation: the handler may already have performed a side effect. A changed fingerprint returns HTTP 409; a
concurrent or unstaged pending request returns HTTP 409. Storage failures fail closed with HTTP 503. A missing product
record paired with the InFlow facilitator's settled-verification marker also returns HTTP 409 without creating a fresh
handler operation.

The helper stages product bytes before settlement and records the final response before emitting it. A staged pending
operation can be recovered with an atomically rotated ownership token; it reuses the product and original authorized
payment, including the actual metered settlement amount. The facilitator must reconcile repeated or concurrent
settlement attempts, including lost responses. The SQLite example renews its two-minute recovery lease when staging a
product and keeps all records. A stopped staged owner remains pending until that lease expires; there is no automatic
reclamation of unstaged handlers. Multi-host deployments need a shared durable database rather than separate SQLite
files. The example restricts the database and existing write-ahead-log/shared-memory sidecars to owner-only access; the
containing directory must also be private.

A handler failure or a crash after a side effect but before staging remains pending and is never automatically rerun.
Exactly-once recovery of that side effect requires a transactional or idempotent application operation; response replay
cannot manufacture a lost product. Back up the database, protect stored payment material and product bytes, monitor
pending records, and reconcile uncertain outcomes before any operator recovery or deletion.

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
- `inflowRoute(client, options)` — builds `accepts` and compatible sponsorship declarations. See below for explicit
  Permit2 selection.
- `inflowSchemeRegistrations(client, options?)` — async helper. Reads the seller's `/v1/x402/config` and returns one
  `SchemeRegistration` per selected `(scheme, network)` pair, with authorization-only payment flows. Fixed-price
  registrations are passthrough; explicitly selected `upto` uses the foundation EVM server. Pass these through the
  adapter's `schemes` argument; the foundation refuses to boot without registrations covering every advertised scheme.
- `X402PriceParseError` — typed error thrown by `inflowAccepts` when a price string doesn't parse.

### Price formats

`PriceSpec.amount` accepts three forms (all support up to 8 decimal places):

| Form                                 | Example                                  | Resolved currency                    |
| ------------------------------------ | ---------------------------------------- | ------------------------------------ |
| `$<integer>(.<decimals>)?`           | `'$0.01'`, `'$10.00000001'`              | `USD`                                |
| `<integer>(.<decimals>)? <CURRENCY>` | `'0.01 USDC'`, `'1 USDT'`, `'0.5 PYUSD'` | from the suffix                      |
| `<integer>(.<decimals>)?` (bare)     | `'0.01'`                                 | from `PriceSpec.currency` (required) |

If both `amount` and `currency` carry a currency and they disagree, the `currency` field wins. `'USD'` is a wildcard
that matches configured stablecoins for balance/blockchain offers. For an explicitly selected Instrument offer it means
fiat USD, not a stablecoin.

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
if (!apiKey) throw new Error('Set INFLOW_API_KEY to a sandbox seller key.');
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

## Linked-card payments

Connect a Stripe account in your InFlow Seller dashboard, then explicitly include `instrument` in the route's schemes.
The buyer needs an InFlow account with a linked card. These are ordinary card charges, not VIC CARD credentials or
stablecoin payments.

```ts
const accepts = await inflowAccepts(client, {
  price: '$1.00',
  schemes: ['instrument'],
});
if (accepts.length === 0) throw new Error('Instrument payments are unavailable for this seller.');
```

Use `accepts` in a route configured as in the quickstart above. `inflowSchemeRegistrations(client)` includes the
server-advertised Instrument registration; if you supply a schemes filter there, include `instrument` too. An
unavailable method produces no offers, so check before starting an Instrument-only route. The runnable
[Instrument example](../../examples/x402-seller-express/src/instrument.ts) performs that check.

Instrument prices must be USD, at least USD 0.50, and expressible in whole cents. The helper rejects invalid prices
rather than rounding them. It emits one `instrument` / `inflow:1` / `USD` offer; a USD 1.00 price is encoded as
`1000000000000000000`, using the server's 18-decimal scale. The server converts the amount to cents for card processing.
Explicit stablecoin prices such as `1 USDC` do not produce Instrument offers.

To offer a card alongside balance and blockchain payments, pass `schemes: ['instrument', 'balance', 'exact']` with a USD
price. The Instrument offer stays in USD while the other offers use configured stablecoins. Omitting `schemes` does not
enable Instrument. Buyers opt in separately with `prefer: ['instrument']`; see the
[buyer guide](../x402-buyer/README.md#paying-with-a-linked-card) for card selection.

Approval authorizes a purchase; it does not confirm a card charge. The facilitator settles the charge when the buyer
redeems the payment payload. If the server returns `409 idempotency_pending`, the facilitator retries the same purchase
up to five total attempts, then throws the error. A pending result is not proof of payment; do not fulfill it or
initiate a replacement purchase automatically. The foundation authorization flow runs the handler before settlement and
buffers the response, so irreversible fulfillment must not rely on handler execution alone.

## Metered EVM payments

Install the optional `@x402/evm@^2.27.0` peer and pass the same `schemes: ['upto']` selection to `inflowAccepts` and
`inflowSchemeRegistrations`. The price is the maximum the external blockchain buyer authorizes. Both helpers omit `upto`
unless explicitly selected; fixed-price exact and balance routes need no EVM peer.

The seller configuration must advertise a matching `upto` supported kind with `assetTransferMethod: 'permit2'`, the
metered `permit2Proxy`, and `facilitatorAddress`. Assets must advertise Permit2 capability through their own
`permit2Proxy`, including assets whose exact transfer method is EIP-3009. An unavailable combination produces no accepts
entries; check for an empty array before starting the route.

In the handler, call `setSettlementOverrides(response, { amount: actualAtomicUnits })` from `@x402/express` before
sending the response. Use an integer string in the selected asset's atomic units, between zero and the authorized
maximum. The middleware sends this amount to settlement while retaining the buyer's signed ceiling. If the handler omits
the override, settlement uses the full advertised maximum. In this authorization flow, Express skips settlement for
handler responses with HTTP status 400 or higher and buffers successful responses until settlement finishes.

See the runnable [metered hashing example](../../examples/x402-seller-express/src/upto.ts), which charges one atomic
USDC unit per input byte. External buyers register `UptoEvmScheme` from `@x402/evm/upto/client` on the foundation
`x402Client`; this is not an InFlow treasury-buyer signing path.

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

Declarations apply to a whole route. If any Permit2 offer lacks EIP-2612 capability, the route omits EIP-2612
sponsorship; use separate routes or a currency filter for incompatible tokens. Missing metadata or facilitator support
never implies sponsorship.

When EIP-2612 cannot be declared, the helper can declare the custom `inflowEip7702GasSponsoring` extension. Every
Permit2 offer must carry explicit `supportsEip7702: true` from seller configuration, and the refreshed facilitator
response must advertise both the extension and matching kinds with `extra.supportsEip7702: true`. External buyers opt in
through [`@inflowpayai/x402-buyer/eip7702`](../x402-buyer/README.md#eip-7702-sponsorship-for-external-wallets). They
authorize persistent delegation and sign the exact atomic approval-and-payment operation. The helper does not declare
the standard `erc20ApprovalGasSponsoring` extension.

Pass the matching InFlow facilitator first in the middleware's facilitator list for sponsored routes. The helper checks
that client's capabilities, not the middleware's final routing: an earlier facilitator claiming the same pair takes
precedence even if it cannot sponsor approval.

External buyers register the foundation `@x402/evm/exact/client` scheme. Foundation 2.27.0 signs the permit when the
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
