# Example — InFlow facilitator as a foundation drop-in

A two-script example proving the InFlow facilitator is a faithful implementation of the foundation's `FacilitatorClient`
contract — operated in its **public / self-hosted-style** mode with no per-seller InFlow account. The seller is a
vanilla `@x402/express` server; the buyer is a vanilla `@x402/evm` client. The only InFlow piece is
`createUnauthenticatedInflowFacilitator` on the seller, which the foundation middleware accepts the same way it accepts
any other facilitator client (Coinbase CDP, a self-hosted facilitator, etc.). No `INFLOW_API_KEY` is required or sent.

No `inflowAccepts`, no `inflowSchemeRegistrations`. The seller hand-builds its `accepts[]` against Base Sepolia USDC —
exactly as a seller using the foundation's reference facilitator would. This is the **InFlow-as-just-a-facilitator**
deployment, not the InFlow-as-the-whole-stack deployment. For the all-in-one mode where InFlow drives both the
facilitator client and the seller's `accepts[]` from a configured InFlow account, see
[`examples/x402-seller-express`](../x402-seller-express) (or the Hono / Fastify / Next 16 variants).

## Run

Two terminals — one per script.

### Seller (terminal A)

```bash
cp .env.example .env
# fill in SELLER_EVM_ADDRESS (no INFLOW_API_KEY is required for this example)
pnpm install
pnpm dev:seller
```

The seller listens on `http://localhost:3000` and serves one route:

| Route              | Price       | Notes                                                                                                |
| ------------------ | ----------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/widgets` | `0.01 USDC` | Base Sepolia USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`). Settled by the InFlow facilitator. |

### Buyer (terminal B)

```bash
# In the same .env, fill in EVM_PRIVATE_KEY (see .env.example for accepted formats)
pnpm dev:buyer
```

Output looks like:

```
GET http://localhost:3000/api/widgets
  status: 200
  body: {"widgets":[1,2,3]}
  paid via InFlow facilitator: <base64 X-PAYMENT-RESPONSE>
```

## Counterparts

- The **InFlow-as-the-whole-stack** seller-side mirror is [`examples/x402-seller-express`](../x402-seller-express)
  (Express), [`examples/x402-seller-hono`](../x402-seller-hono) (Hono),
  [`examples/x402-seller-fastify`](../x402-seller-fastify) (Fastify), or
  [`examples/x402-seller-next`](../x402-seller-next) (Next 16). Those examples use `inflowAccepts` and
  `inflowSchemeRegistrations` to source the `accepts[]` from the seller's InFlow config rather than hand-building it.
- The buyer in this example is shape-identical to [`examples/x402-buyer-x402-evm`](../x402-buyer-x402-evm).
