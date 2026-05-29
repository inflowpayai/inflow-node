# Architecture

How InFlow's three `@inflowpayai/x402*` packages compose with the foundation V2 middleware and buyer transport to
deliver an x402 integration.

## What InFlow ships vs. what the foundation owns

InFlow does **not** ship seller middleware. The foundation already ships `paymentMiddlewareFromConfig` in
`@x402/express` and `@x402/hono`; it owns the request loop, paywall, settlement hooks, and multi-facilitator resolution
via declaration order. InFlow plugs into that — the seller-side value-add is three factories and one helper:

| InFlow surface                           | Returns                         | Drops into                                                                                      |
| ---------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `createInflowFacilitator`                | foundation `FacilitatorClient`  | `paymentMiddlewareFromConfig`'s `facilitatorClients[]`                                          |
| `createUnauthenticatedInflowFacilitator` | foundation `FacilitatorClient`  | same — for facilitator-only deployments                                                         |
| `createInflowSellerClient`               | `InflowSellerClient`            | drives `inflowAccepts`                                                                          |
| `inflowAccepts(client, options)`         | foundation `PaymentOption[]`    | a route's `accepts` field in `RoutesConfig`                                                     |
| `inflowSchemeRegistrations(client)`      | `Promise<SchemeRegistration[]>` | `paymentMiddlewareFromConfig`'s third `schemes` arg — the foundation refuses to boot without it |

The buyer side ships `InflowClient`, a subclass of the foundation's `x402Client`. The buyer composes by passing the
`InflowClient` instance to the foundation's `x402HTTPClient` transport and to any `registerExactEvmScheme` /
`registerExactSvmScheme` helpers — same client, one routing override, no parallel wrapper packages.

## Package layering

```
                @inflowpayai/x402  (core: types, http client, constants)
                /                \
               /                  \
  @inflowpayai/x402-seller    @inflowpayai/x402-buyer
                              (InflowClient extends x402Client)
```

The seller package has no framework adapter packages — sellers depend on `@x402/express`, `@x402/hono`, `@x402/fastify`,
or `@x402/next` directly. The buyer package likewise has no transport adapter — buyers use `@x402/core`'s
`x402HTTPClient` with their preferred HTTP client (`fetch`, `axios`, etc.).

## Seller side — request lifecycle

```
buyer                   foundation middleware              InFlow facilitator         InFlow server
  │                           │                                  │                          │
  │   GET /api/widgets        │                                  │                          │
  │ ────────────────────────▶ │                                  │                          │
  │                           │ match route?                     │                          │
  │                           │ (init) check hasRegisteredScheme │                          │
  │                           │   for every advertised scheme    │                          │
  │                           │   (inflowSchemeRegistrations     │                          │
  │                           │   covers balance and friends);   │                          │
  │                           │   then get supported per         │                          │
  │                           │   facilitator client; first      │                          │
  │                           │   claimer of (scheme, network)   │                          │
  │                           │   wins routing                   │                          │
  │                           │ ─────── getSupported() ────────▶ │   GET /v1/x402/supported │
  │                           │                                  │ ───────────────────────▶ │
  │                           │ ◀───── SupportedResponse ─────── │ ◀─────────────────────── │
  │                           │                                  │                          │
  │                           │ assemble PaymentRequired from    │                          │
  │                           │   route's accepts[] (built       │                          │
  │                           │   from inflowAccepts)            │                          │
  │  402 + PAYMENT-REQUIRED   │                                  │                          │
  │ ◀──────────────────────── │                                  │                          │
  │                           │                                  │                          │
  │   GET /api/widgets +      │                                  │                          │
  │   PAYMENT-SIGNATURE       │                                  │                          │
  │ ────────────────────────▶ │                                  │                          │
  │                           │ decode payload                   │                          │
  │                           │ route to facilitator by          │                          │
  │                           │   (scheme, network)              │                          │
  │                           │ ─────── verify ────────────────▶ │   POST /v1/x402/verify   │
  │                           │                                  │ ───────────────────────▶ │
  │                           │ ◀──── { isValid: true } ──────── │ ◀─────────────────────── │
  │                           │                                  │                          │
  │                           │ next() → protected handler       │                          │
  │                           │ res.end intercepted              │                          │
  │                           │ ─────── settle ────────────────▶ │   POST /v1/x402/settle   │
  │                           │                                  │ ───────────────────────▶ │
  │                           │ ◀──── SettleResponse ─────────── │ ◀─────────────────────── │
  │  200 + PAYMENT-RESPONSE   │                                  │                          │
  │ ◀──────────────────────── │                                  │                          │
```

The seller fetches `/v1/x402/config` once at startup (via `createInflowSellerClient`), expands it into `PaymentOption[]`
via `inflowAccepts`, and hands the result to the foundation middleware in each route's `accepts` field. The foundation
middleware never calls `/v1/x402/config` itself — it consumes `PaymentOption[]` shapes that already have `payTo`,
`asset`, and atomic `amount` resolved.

## Buyer side — request lifecycle

```
caller            x402HTTPClient                InflowClient                      InFlow server
  │                    │                            │                                       │
  │  fetch(url)        │                            │                                       │
  │ ─────────────────────────────────────────────────────────────────────────────────────▶  │ (seller)
  │ ◀─ 402 + PAYMENT-REQUIRED ──────────────────────────────────────────────────────────────│
  │                    │                            │                                       │
  │  getPaymentRequiredResponse(headers)            │                                       │
  │ ─────────────────▶ │                            │                                       │
  │                    │  createPaymentPayload(req) │                                       │
  │                    │ ──────────────────────────▶│                                       │
  │                    │                            │ pickInflowMatch → InFlow branch       │
  │                    │                            │   POST /v1/transactions/x402          │
  │                    │                            │ ────────────────────────────────────▶ │
  │                    │                            │ ◀── approvalId, ... ───────────────── │
  │                    │                            │   poll GET /v1/transactions/{id}/x402 │
  │                    │                            │ ────────────────────────────────────▶ │
  │                    │                            │ ◀── { status, paymentPayload, ... } ──│
  │                    │ ◀── PaymentPayload ──────  │                                       │
  │  encodePaymentSignatureHeader(payload)          │                                       │
  │ ◀───────────────── │                            │                                       │
  │                    │                            │                                       │
  │  retry fetch(url) + PAYMENT-SIGNATURE                                                   │
  │ ─────────────────────────────────────────────────────────────────────────────────────▶  │ (seller)
  │ ◀── 200 + PAYMENT-RESPONSE ─────────────────────────────────────────────────────────────│
  │  processResponse(paid) → x402PaymentResult                                              │
  │ ─────────────────▶ │                            │                                       │
  │ ◀── { kind: 'success', body, settleResponse } ──│                                       │
```

The `InflowClient.createPaymentPayload` call is two-phase under the hood when it routes to the InFlow branch: a
synchronous `POST /v1/transactions/x402` creates the buyer's Approval, then a polling loop on
`GET /v1/transactions/{id}/x402` waits for the server to sign. The polling cadence is a fixed 5 s; the default total
budget is 15 minutes to match the server-side approval expiry. The foundation transport
(`x402HTTPClient.encodePaymentSignatureHeader`) re-encodes the parsed payload via `JSON.stringify` + base64; the InFlow
facilitator decodes with `Base64.getMimeDecoder()` + lenient JSON parse, so the round trip is wire-equivalent.

When no `accepts[]` entry matches the InFlow buyer capability cache, the override delegates to
`super.createPaymentPayload`, which uses the foundation's selector to route to whatever scheme the caller registered on
the same `InflowClient` instance via `registerExactEvmScheme` / `registerExactSvmScheme` / etc.

## Conflict precedence: foundation declaration order

The foundation middleware resolves overlapping `(scheme, network)` claims by **declaration order** in the
`facilitatorClients` array. Direct quote from `x402ResourceServer.initialize()`:

```js
for (const facilitatorClient of this.facilitatorClients) {
  const supported = await facilitatorClient.getSupported();
  for (const kind of supported.kinds) {
    if (!responseNetworkMap.has(kind.scheme)) {
      responseNetworkMap.set(kind.scheme, supported);
      clientNetworkMap.set(kind.scheme, facilitatorClient);
    }
  }
}
```

First claimer wins; subsequent claimers are silently ignored. Sellers control resolution by ordering the array:

```ts
paymentMiddlewareFromConfig(
  {
    /* routes */
  },
  [
    inflow, // wins on (balance, inflow) and any (exact, *)
    cdp, // wins only on entries inflow doesn't claim
    partnerNetwork,
  ],
);
```

The buyer side uses a different but parallel rule: `InflowClient.createPaymentPayload` checks the InFlow buyer
capability cache first (in `prefer`-scheme order), then falls back to `super.createPaymentPayload` for any requirement
InFlow can't sign. The fallback uses the foundation's own selector against the schemes registered on the client. InFlow
always wins when its cache matches; foundation schemes only run when no InFlow `(scheme, network)` pair fits.

## `inflowAccepts` algorithm

Given an `InflowSellerClient` and a `PriceSpec`, `inflowAccepts` produces a foundation `PaymentOption[]`:

1. **On-chain entries**: for each `wallet` in the seller's config, match every `asset` with
   `asset.blockchain === wallet.blockchain` and a compatible currency. Emit one `PaymentOption` per `(wallet, asset)`
   pair using `asset.assetTransferMethod` verbatim — the SDK does **not** fan out an implicit EIP-3009/Permit2 pair.
   Sellers that want both schemes publish both assets in their `/v1/x402/config`. For Permit2 entries,
   `extra.permit2Proxy` is set from `asset.permit2Proxy`.
2. **Non-blockchain entries**: for each `paymentMethod` (`balance`, future `instrument`), emit one `PaymentOption` using
   the method's own `payTo` and decimals.
3. **Filter**: `options.schemes` and `options.networks` are combined as logical AND. Omit either for "any."

Ordering: on-chain entries by wallet declaration order, then payment methods in declaration order.

Extension declarations are not produced by `inflowAccepts` — per-route declarations live on `RouteConfig.extensions`,
and facilitator-wide declarations come from each `FacilitatorClient.getSupported().extensions` and are merged by the
middleware.

## `inflowSchemeRegistrations`

The foundation middleware checks `hasRegisteredScheme(scheme, network)` before it consults any
`FacilitatorClient.getSupported()`. A facilitator that advertises support for a scheme the middleware doesn't know how
to **register** cannot be used: the middleware refuses to boot. `inflowSchemeRegistrations()` returns the passthrough
`SchemeRegistration[]` for `balance` (and any future InFlow-managed schemes) and is meant to be passed as the third
argument to `paymentMiddlewareFromConfig` alongside any framework-native registrations (`registerExactEvmScheme` /
`registerExactSvmScheme`):

```ts
paymentMiddlewareFromConfig(
  routes,
  [inflowFacilitator /* others */],
  [...(await inflowSchemeRegistrations(client)), registerExactEvmScheme(), registerExactSvmScheme()],
);
```

The registrations are passthrough — they don't sign or settle anything themselves; the InFlow facilitator handles both.
They exist solely to satisfy the middleware's scheme-knowledge check at boot.

## Server-side auto-upgrade

When both buyer and seller are InFlow accounts, the InFlow server may rewrite a buyer-chosen `exact` requirement into a
`balance` requirement before signing (free internal transfer). The SDK propagates the server's signed payload verbatim —
`EncodedPayment.paymentPayload.accepted` is the requirement the server actually settled, which may differ from the one
the buyer originally selected. Downstream consumers (metrics, auditing) should key off `paymentPayload.accepted`, not
the locally-selected requirement.

## Orphan approvals

`InflowClient.prepareInflowPayment()` issues `POST /v1/transactions/x402` synchronously, which creates the server-side
Approval before returning. If the caller aborts after `prepareInflowPayment()` resolves but before `awaitPayload()`
returns, the Approval would otherwise sit pending until the 15-minute server-side expiry. Three things together keep
this clean:

- `InflowClient.createPaymentPayload()` internally calls the InFlow signer's one-shot path, which wraps `prepare` →
  `awaitPayload` with an auto-cancel-on-error fire-and-forget POST. A failed sign cleans itself up.
- `PreparedPayment.cancel()` is fire-and-forget — it never rejects. Safe to call unconditionally in a `finally`.
- The 15-minute server expiry bounds the worst case even when the cancel POST fails to land.

## See also

- [protocol-mapping.md](./protocol-mapping.md) for wire-shape details and network identifier rules.
- [extensions.md](./extensions.md) for the extension handler contract.
