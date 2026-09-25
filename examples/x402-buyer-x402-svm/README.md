# Example — x402 SVM buyer (foundation-only)

A vanilla x402 SVM buyer that recognises and pays an InFlow-generated 402. **No `@inflowpayai/*` imports** — that's the
point: the buyer side reads InFlow's `accepts[]` the same way it reads any other foundation `accepts[]`. The
InFlow-specific work all happens on the seller side; from this side the wire is just x402.

Default network is Solana devnet. The CAIP-2 identifier is `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — the
genesis-hash-based CAIP-2 namespace value `@x402/svm` exports as `SOLANA_DEVNET_CAIP2`. The shorthand alias
`solana:devnet` is not a valid CAIP-2 value and is rejected by the package's `normalizeNetwork`.

## Run

Start one of the seller examples first (`examples/x402-seller-express`, `examples/x402-seller-hono`,
`examples/x402-seller-fastify`, or `examples/x402-seller-next`), then in another terminal:

```bash
cp .env.example .env
# fill in SOLANA_PRIVATE_KEY — see .env.example for accepted formats
pnpm install
pnpm start
```

`SOLANA_PRIVATE_KEY` accepts two input encodings, auto-detected by the first non-whitespace character:

| First char    | Encoding                                                                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[`           | JSON byte array of 64 ints in `0..255` — matches `solana-keygen`'s on-disk format.                                                                                                                                                                                         |
| anything else | base58 string — matches InFlow's `SolanaClient.Account.getSeed()` (`Base58.encode(keyPair.getSecretKey())` per [`Account.java:153-155`](../../../inflow-server/src/main/java/ai/inflowpay/blockchain/solana/model/Account.java)) and Phantom's exported secret-key string. |

Either encoding must decode to exactly 64 bytes (the Ed25519 secret key: first 32 bytes are the seed, the last 32 are
the public key). On any decode failure the example throws with both accepted forms named in the error message.

Default target is `http://localhost:3000/api/widgets`. Override with `TARGET_URL=...` in `.env`.

### `SOLANA_PAYMENT_MINT` — pinning the SPL Token mint the buyer pays in

The example registers a payment policy on the foundation `x402Client` that filters the seller's advertised `accepts[]`
down to entries whose `asset` matches a chosen SPL Token mint. The default is Circle's canonical devnet USDC
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). Override with the optional `SOLANA_PAYMENT_MINT` env var when paying a
sandbox or seller that uses a custom test mint — the buyer wallet must hold (and have an ATA for) the chosen mint, so
the override has to match a mint you actually have a balance in.

The standard mint uses the foundation's default $1 per-payment cap. For a custom mint, also set
`SOLANA_MAX_AMOUNT_ATOMIC` to a positive integer in that mint's smallest units. For example, `1000000` permits at most 1
token per payment for a mint with 6 decimals. This is a token limit, not a USD valuation. The same setting can
explicitly override the standard mint's cap.

Spend controls run before the mint policy. The KEEP/drop log shows only requirements that passed those controls. An
unapproved asset or an amount above the configured cap is rejected before signing; the policy then rejects any remaining
entries for a different mint.

Output looks like:

```
GET http://localhost:3000/api/widgets
  status: 200
  body: {"widgets":[1,2,3]}
  paid: <base64 X-PAYMENT-RESPONSE header>
```

## Public counterpart

The same key-decoder logic ships from `@inflowpayai/x402-buyer` as the published
`decodeSolanaSecret(value: string): Uint8Array` (throws `X402InvalidSolanaKeyError`). The example duplicates it inline
to preserve the foundation-only invariant.

The InFlow-side buyer using the same protocol but with InFlow's signer (no on-chain hot key required) is
[`examples/x402-buyer-fetch`](../x402-buyer-fetch).
