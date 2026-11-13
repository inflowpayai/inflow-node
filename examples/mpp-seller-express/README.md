# Example — MPP seller on Express

A minimal Express app that accepts MPP payments via InFlow. Uses `inflowChargesNodeListener` with request-time pricing
and InFlow's `inflow` seller method on `mppx/server`. `Mppx.create` mints and HMAC-binds the challenge locally with
`secretKey`; the `inflow` method's `verify` redeems and settles through the InFlow PSP.

## Prerequisite

This example requires an InFlow **Seller** account and an API key created in its dashboard:

- [Sandbox registration](https://sandbox.inflowpay.ai) for testing
- [Production registration](https://app.inflowpay.ai) for live payments

A Developer account is a different API role and cannot be used in place of a Seller account for this example.

## Run

```bash
cp .env.example .env
# fill in INFLOW_API_KEY from your sandbox account, and set MPP_SECRET_KEY (see the mppx docs)
pnpm install
pnpm dev
```

## USD linked-card example

To accept an ordinary card linked to an InFlow buyer account, connect a Stripe account in the sandbox Seller dashboard
and complete Stripe onboarding so the account can accept charges. Run this separate entry point instead of `pnpm dev`:

```bash
pnpm start:instrument
```

`GET http://localhost:3000/api/report` costs USD 1.00 and offers only `inflow/charge` on the `instrument` rail. The
buyer approves the purchase in InFlow; InFlow charges the selected linked card when the seller redeems the credential.
This is not VIC `card/charge` or Stripe Shared Payment Tokens. The seller example needs no Stripe secret, card number or
buyer Instrument ID.

Use the [manual buyer example](../mpp-buyer-manual#pay-the-usd-linked-card-example) with a separate buyer API key. The
buyer needs a linked sandbox card and may choose its ID or use their primary card. The minimum is USD 0.50, with amounts
in whole cents; this example uses USD 1.00. Failed or pending settlement does not run the protected route handler.

A bank may require verification after InFlow approval. The buyer must complete that step through the dashboard, then
retry the original request with its existing credential. See
[card verification and recovery](../../packages/mpp/README.md#card-verification-and-payment-status). The example does
not open a verification page or create a replacement payment on failure.

`INFLOW_BASE_URL` is an optional override for a development InFlow API. Leave it empty to use sandbox; both buyer and
seller must use the same environment. Send API keys only to an InFlow API you trust.

## Balance and multi-currency examples

The server listens on `http://localhost:3000` and serves these routes:

| Route                | Price                       | Notes                                                                          |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/widgets`   | `0.01` or `0.05 USDC`       | `?bundle=large` selects the larger bundle; balance rail.                       |
| `POST /api/upload`   | `0.10` or `0.20 USDC`       | `?priority=high` selects priority processing; balance rail.                    |
| `GET /api/subscribe` | `1.00 USDC` monthly         | Recurring subscription on the `balance` rail.                                  |
| `GET /api/checkout`  | `1.00 USD` or `0.0095 USDC` | `?bundle=large` doubles both prices (USD → `instrument`, USDC → `balance`).    |
| `GET /api/search`    | Request-priced USD or USDC  | `?detail=full` selects USD 1.00 or USDC 0.25; otherwise USD 0.50 or USDC 0.10. |
| `GET /free`          | —                           | Not gated; passes through.                                                     |

Each charge callback reads the request and returns the seller's prices; it does not accept a buyer-supplied amount. The
helper handles both single- and multi-currency routes. Prices must remain stable between the unpaid request and its paid
retry. Fixed price lists are also supported. Subscriptions use a separate helper with fixed plan terms.

Hit it with the matching buyer example or any other MPP client:

```bash
cd ../mpp-buyer-fetch
INFLOW_API_KEY=$INFLOW_API_KEY TARGET_URL=http://localhost:3000/api/widgets pnpm start
```
