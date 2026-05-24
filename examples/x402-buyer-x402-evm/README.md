# Example — x402 EVM buyer (foundation-only)

A vanilla x402 EVM buyer that recognises and pays an InFlow-generated 402. **No `@inflowpayai/*` imports** — that's the point: the
buyer side reads InFlow's `accepts[]` the same way it reads any other foundation `accepts[]`. The InFlow-specific work all happens
on the seller side; from this side the wire is just x402.

Default network is Base Sepolia (`eip155:84532`). USDC contract at `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

## Run

Start one of the seller examples first (`examples/x402-seller-express`, `examples/x402-seller-hono`,
`examples/x402-seller-fastify`, or `examples/x402-seller-next`), then in another terminal:

```bash
cp .env.example .env
# fill in EVM_PRIVATE_KEY — see .env.example for accepted formats
pnpm install
pnpm start
```

`EVM_PRIVATE_KEY` accepts the industry-standard `0x`-prefixed (or bare) 64-char hex, and also InFlow's Java seed format —
`Hex.encodeHexString(BigInteger.toByteArray())` from
[`inflow-server/.../HDWallet.java:56`](../../../inflow-server/src/main/java/ai/inflowpay/blockchain/model/HDWallet.java).
The two `BigInteger`-shape quirks — the leading-`00` sign byte on keys whose top bit is set, and the stripped leading zeros on
small keys — are normalized at the example boundary so the rest of the script sees viem's expected `0x`-prefixed 32-byte form.
The seller needs Base Sepolia USDC at `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

Default target is `http://localhost:3000/api/widgets`. Override with `TARGET_URL=...` in `.env`.

Output looks like:

```
GET http://localhost:3000/api/widgets
  status: 200
  body: {"widgets":[1,2,3]}
  paid: <base64 X-PAYMENT-RESPONSE header>
```

## Counterpart

The InFlow-side buyer using the same protocol but with InFlow's signer (no on-chain hot key required) is
[`examples/x402-buyer-fetch`](../x402-buyer-fetch).
