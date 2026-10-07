# CARD seller with Express

Accept a USD 1.00 Visa network-token payment through InFlow's `card/charge` method. The Express route returns its report
only after InFlow confirms payment and adds a `Payment-Receipt` response header.

The charge sets `scope: 'GET /report'` to bind credentials to this route. Set a distinct scope for each protected
operation; for orders or individually purchased resources, include the order or resource identifier as well. The Express
adapter does not infer that binding for you.

## Prerequisites

- Node.js 22 or newer and pnpm.
- An InFlow **Seller** account in [Sandbox](https://sandbox.inflowpay.ai), a Seller API key, and a connected Stripe
  account with charging enabled. Connect Stripe in the InFlow dashboard.
- For an InFlow buyer, an account in the same environment with a linked Visa card and a verified VIC allowance. Use the
  [buyer package's `card` method](../../packages/mpp-buyer/README.md#pay-a-card-offer-with-a-vic-allowance) to request
  the encrypted credential. External buyers can use another compatible CARD client. An ordinary card number or a Stripe
  Shared Payment Token is not a CARD credential.

The example uses Sandbox explicitly. Your application needs neither Stripe API credentials nor an encryption private
key. InFlow supplies the public encryption key and merchant details and performs decryption and processing. Keep the
Seller API key and your application's challenge-signing secret private.

## Run

From the repository root:

```sh
pnpm install
pnpm --filter @inflowpayai/mpp-seller... build
cd examples/mpp-card-seller-express
cp .env.example .env
openssl rand -base64 32
```

Set `INFLOW_API_KEY` in `.env` to your Sandbox Seller key and `MPP_SECRET_KEY` to the generated secret. Retain that
secret across restarts so outstanding challenges remain verifiable. Then run:

```sh
pnpm dev
curl -i http://localhost:3000/report
```

The unpaid request returns HTTP 402. Decode its `WWW-Authenticate` request to see `amount: "100"`, `currency: "usd"`,
your connected Stripe recipient, Visa acceptance and the public encryption key. The route price `"1.00"` is in dollars;
the wire price `"100"` is in cents. Run behind HTTPS outside local development.

To complete payment, the buyer obtains a credential for that exact challenge and retries `/report` with
`Authorization: Payment <credential>`. The encrypted credential is forwarded to InFlow unchanged. Do not log it. An
unpaid request proves challenge generation, not network-token processing or provider enablement. Full payment testing
requires compatible provider test credentials; this example does not generate them.

CARD accepts external buyers without an InFlow buyer login. Your own application authentication, if needed, is separate
from this payment middleware. [`stripe(...)`](../../packages/mpp-seller#stripe-one-time-charges) is the separate method
for Stripe Shared Payment Tokens, including Stripe Link; enabling one method does not enable the other.

To use the CARD buyer snippet linked above, change its URL to `http://localhost:3000/report` and supply the seller's
actual business name, website and two-letter country code in `context.merchant`. Those are merchant details, not the
buyer's billing address. Supply `context.instrumentId` to select a particular linked card, or omit it to use the buyer's
primary card. The buyer uses its own API key, not the Seller key from this example's `.env` file.
