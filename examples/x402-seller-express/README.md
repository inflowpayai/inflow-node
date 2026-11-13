# Example — x402 seller on Express

A minimal Express app that accepts x402 payments via InFlow. Uses the foundation V2 middleware (`paymentMiddleware` from
`@x402/express`) with `createInflowHTTPResourceServer` and request-time routes built using `inflowAccepts`.

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

The server listens on `http://localhost:3000`:

| Route                | Price                 | Notes                                                          |
| -------------------- | --------------------- | -------------------------------------------------------------- |
| `GET /api/widgets`   | `$0.01` or `$0.05`    | `?bundle=large` selects the larger bundle; exact payments.     |
| `GET /api/sponsored` | `0.01 USDC`           | Base Sepolia Permit2; authorization flow.                      |
| `POST /api/upload`   | `0.10` or `0.20 USDC` | `?priority=high` selects priority processing; balance + exact. |
| `GET /api/report`    | `0.10` or `0.25 USDC` | `?detail=full` selects the full report; upfront settlement.    |
| `GET /api/search`    | `0.10` or `0.25`      | Request-time amount and currency via `inflowAccepts`.          |
| `GET /free`          | —                     | Not protected; passes through.                                 |

For `/api/search`, `?detail=full` selects 0.25 instead of 0.10; `?currency=USDT` selects USDT instead of USDC. The
callback returns the seller's price for the requested service. Networks without the selected currency are omitted; `$`
prices expand to configured stablecoins. A request with no matching payment options fails rather than becoming free.
Prices must remain stable between the unpaid request and its paid retry. Fixed prices are also supported; the sponsored
route demonstrates fixed pricing with `inflowRoute`.

Hit it with the matching buyer example or any other x402 client:

```bash
cd ../x402-buyer-fetch
INFLOW_API_KEY=$INFLOW_API_KEY TARGET_URL=http://localhost:3000/api/widgets pnpm start
```

## Linked-card route

Connect a Stripe account in your sandbox Seller dashboard, then run `pnpm start:instrument`. This separate example
serves `GET /api/report` for USD 1.00 using only the `instrument` scheme. It stops at startup if the seller
configuration does not advertise Instrument support; it does not fall back to a stablecoin offer.

The buyer needs a linked card and must explicitly select `prefer: ['instrument']`; the default buyer preferences do not
include card payments. See the [buyer configuration](../../packages/x402-buyer/README.md#paying-with-a-linked-card).
Omit the Instrument ID to use the primary card, or supply an owned card's ID. Use sandbox accounts and cards for this
example. Approval alone does not mean a charge has succeeded.

## Metered Permit2 route

Run `pnpm start:upto` for `POST /api/hash`. This variant requires the sandbox seller configuration to advertise `upto`
for USDC and a deployed metered Permit2 proxy. It accepts a `text/plain` body of at most 100000 bytes, authorizes a
maximum of 0.10 USDC, and settles one atomic USDC unit per input byte. The foundation's
`setSettlementOverrides(response, { amount })` carries the measured usage to the facilitator.

Pay with an external wallet using `UptoEvmScheme` from `@x402/evm/upto/client`, registered on a foundation `x402Client`.
The wallet needs token allowance to Permit2. InFlow treasury buyers do not sign this payment method.
