# Example — `@inflowpayai/mpp-buyer` with explicit `mppx.fetch`

A minimal script that pays for a protected resource through the explicit, non-polyfill path.
`Mppx.create({ polyfill: false })` leaves the global `fetch` untouched; payment happens only on the returned
`mppx.fetch`.

This example is fixed to the InFlow sandbox. Use an API key from a sandbox Developer account or an existing sandbox
Seller account.

## Run

Start one of the seller examples first (`examples/mpp-seller-express` or `examples/mpp-seller-hono`), then in another
terminal:

```bash
cp .env.example .env
# fill in INFLOW_API_KEY from https://sandbox.inflowpay.ai
pnpm install
pnpm start
```

Default target is `http://localhost:3000/api/widgets`. Override with `TARGET_URL=...` in `.env`.

## Pay the USD linked-card example

Start `pnpm start:instrument` in `examples/mpp-seller-express`. In your sandbox buyer dashboard, link a test card and
make it your primary card. Use this buyer account's API key in this example's `.env`, not the seller's key.

```bash
TARGET_URL=http://localhost:3000/api/report pnpm start
```

This requests one USD 1.00 purchase. Approve it in InFlow when prompted there, unless an existing policy approves it. An
empty `INSTRUMENT_ID` uses your primary card. To choose a different linked card, set `INSTRUMENT_ID` in `.env` to that
card's Instrument ID. An invalid or unavailable selection fails; the server does not choose another card. The script
passes this selection to InFlow, not to the seller.

The script permits one payment attempt (`maxPaymentRetries: 1`) and prints the seller's response and receipt. It does
not automate bank verification or recovery. If settlement is pending or the connection fails after approval, do not
rerun the script to recover: another run can create another purchase. Use the original transaction ID to
[check payment status and recover its credential](../../packages/mpp/README.md#card-verification-and-payment-status). An
application that needs this recovery must retain the original transaction ID and credential; use `MppClient` directly
for that control instead of this minimal `mppx.fetch` example.

`INFLOW_BASE_URL` optionally points both examples at a development InFlow API. Leave it empty for sandbox and use an API
key from the same environment. The buyer's key must never be sent to `TARGET_URL`.

## Successful output

Output looks like:

```
GET http://localhost:3000/api/widgets
  status: 200
  body: {"widgets":[1,2,3]}
  paid via inflow: 86f75793-abeb-4fe6-9a46-61901be77070
```

For the transparent, polyfilled-`fetch` path, see [`../mpp-buyer-fetch`](../mpp-buyer-fetch).
