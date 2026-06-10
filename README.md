# inflow-node

[![CI](https://github.com/inflowpayai/inflow-node/actions/workflows/ci.yml/badge.svg)](https://github.com/inflowpayai/inflow-node/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/inflowpayai/inflow-node/branch/main/graph/badge.svg)](https://codecov.io/gh/inflowpayai/inflow-node)
[![node](https://img.shields.io/node/v/@inflowpayai/x402)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Discord](https://img.shields.io/discord/1488618872461332562?logo=discord&logoColor=white&label=Discord)](https://discord.gg/Z9nmMAgaR4)

Official Node.js SDKs for the [InFlow](https://www.inflowpay.ai) payments platform.

## Accounts & environments

Register a Seller account and create an API key in the InFlow dashboard, then pass `environment` to the SDK. That's the
only configuration you need — the SDK resolves the right endpoint internally (don't set `baseUrl`).

| `environment`       | Register / get your API key at |
| ------------------- | ------------------------------ |
| `sandbox` (testing) | `https://sandbox.inflowpay.ai` |
| `production` (live) | `https://app.inflowpay.ai`     |

> For network egress allowlisting only: the SDK makes its outbound API calls to `https://sandbox.inflowpay.ai` (sandbox)
> and `https://api.inflowpay.ai` (production). You never set these yourself.

## What's here

This monorepo houses InFlow's open-source Node.js packages, organized by product. Every package, example, and product
doc folder uses a product prefix (`x402-`, …) so multiple products can coexist without ambiguity.

| Product  | What it does                                                                             | Docs                                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **x402** | x402 protocol integration — facilitator client, seller helpers, buyer wrappers.          | [overview](./docs/x402/README.md) · [architecture](./docs/x402/architecture.md) · [wire format](./docs/x402/protocol-mapping.md) · [extensions](./docs/x402/extensions.md) |
| **mpp**  | MPP (Machine Payments Protocol) integration — the `inflow` method, seller/buyer drivers. | [overview](./docs/mpp/README.md) · [architecture](./docs/mpp/architecture.md) · [wire format](./docs/mpp/protocol-mapping.md) · [extensions](./docs/mpp/extensions.md)     |

## Packages

All packages publish under the `@inflowpayai` scope on npm and depend on `@x402/core@^2.12.0` as a peer.

| Package                                              | npm                                                                                                                     | Role                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`@inflowpayai/x402`](./packages/x402)               | [![npm](https://img.shields.io/npm/v/@inflowpayai/x402)](https://www.npmjs.com/package/@inflowpayai/x402)               | Core types + HTTP client                                     |
| [`@inflowpayai/x402-seller`](./packages/x402-seller) | [![npm](https://img.shields.io/npm/v/@inflowpayai/x402-seller)](https://www.npmjs.com/package/@inflowpayai/x402-seller) | Facilitator client + seller client + `inflowAccepts` helper  |
| [`@inflowpayai/x402-buyer`](./packages/x402-buyer)   | [![npm](https://img.shields.io/npm/v/@inflowpayai/x402-buyer)](https://www.npmjs.com/package/@inflowpayai/x402-buyer)   | `InflowClient` — foundation `x402Client` subclass for buyers |

The **MPP** packages publish under the same scope but declare [`mppx`](https://github.com/wevm/mppx)`@^0.6.28` as their
peer instead of `@x402/core`:

| Package                                            | npm                                                                                                                   | Role                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`@inflowpayai/mpp`](./packages/mpp)               | [![npm](https://img.shields.io/npm/v/@inflowpayai/mpp)](https://www.npmjs.com/package/@inflowpayai/mpp)               | Core: the `inflow` `Method` definition, wire types, codec, HTTP client |
| [`@inflowpayai/mpp-seller`](./packages/mpp-seller) | [![npm](https://img.shields.io/npm/v/@inflowpayai/mpp-seller)](https://www.npmjs.com/package/@inflowpayai/mpp-seller) | `Method.toServer` + InFlow redeem/settle driver — accepting MPP        |
| [`@inflowpayai/mpp-buyer`](./packages/mpp-buyer)   | [![npm](https://img.shields.io/npm/v/@inflowpayai/mpp-buyer)](https://www.npmjs.com/package/@inflowpayai/mpp-buyer)   | `Method.toClient` + InFlow buyer-endpoint driver — paying via MPP      |

```bash
# Seller accepting MPP payments
pnpm add @inflowpayai/mpp-seller mppx

# Buyer paying via MPP
pnpm add @inflowpayai/mpp-buyer mppx
```

See the [MPP product docs](./docs/mpp/README.md) for the seller/buyer integration shape.

Sellers integrate via the foundation V2 middleware (`paymentMiddlewareFromConfig` from `@x402/express`, `@x402/hono`,
`@x402/fastify`, or `@x402/next`) and pass InFlow's facilitator client into its `facilitatorClients` array. See the
[x402 quickstart](./docs/x402/README.md) for the integration shape.

Common installs:

```bash
# Seller in Express (foundation middleware + InFlow facilitator)
pnpm add @inflowpayai/x402-seller @x402/express @x402/core express

# Seller in Fastify
pnpm add @inflowpayai/x402-seller @x402/fastify @x402/core fastify

# Seller in Next 16 App Router
pnpm add @inflowpayai/x402-seller @x402/next @x402/core next

# Buyer (InFlow-signed paths only)
pnpm add @inflowpayai/x402-buyer @x402/core

# Buyer composing InFlow with foundation EVM and/or SVM signing
pnpm add @inflowpayai/x402-buyer @x402/core @x402/evm @x402/svm
```

See the [x402 product docs](./docs/x402/README.md) for quickstarts.

## Examples

Runnable end-to-end examples live in [`examples/`](./examples). Start a seller, then run a buyer against it.

**x402:**

- [`x402-seller-express`](./examples/x402-seller-express) — Express server with three protected routes.
- [`x402-seller-hono`](./examples/x402-seller-hono) — same shape on Hono via `@hono/node-server`.
- [`x402-seller-fastify`](./examples/x402-seller-fastify) — same shape on Fastify; `@x402/fastify` mutates the Fastify
  instance in place rather than returning middleware.
- [`x402-seller-next`](./examples/x402-seller-next) — Next 16 App Router; `proxy.ts` carries the InFlow wiring and Route
  Handlers stay x402-free.
- [`x402-buyer-fetch`](./examples/x402-buyer-fetch) — paying a protected endpoint with `@inflowpayai/x402-buyer` +
  native `fetch`.
- [`x402-buyer-axios`](./examples/x402-buyer-axios) — paying a protected endpoint with `@inflowpayai/x402-buyer` +
  `axios`.
- [`x402-buyer-x402-evm`](./examples/x402-buyer-x402-evm) — foundation-only EVM buyer (no `@inflowpayai/*` imports)
  paying an InFlow seller.
- [`x402-buyer-x402-svm`](./examples/x402-buyer-x402-svm) — foundation-only SVM buyer paying an InFlow seller; same idea
  on Solana devnet.
- [`x402-facilitator`](./examples/x402-facilitator) — InFlow facilitator as a foundation drop-in: vanilla
  `@x402/express` seller + foundation-only EVM buyer, with no `INFLOW_API_KEY` (uses
  `createUnauthenticatedInflowFacilitator`).

**MPP:**

- [`mpp-seller-express`](./examples/mpp-seller-express) — Express server accepting MPP payments via `mppx`'s Express
  adapter + InFlow's `inflow` seller method, plus a multi-currency `/api/checkout` route via
  `inflowChargesNodeListener`.
- [`mpp-seller-hono`](./examples/mpp-seller-hono) — same shape on Hono via `mppx/hono` and `@hono/node-server`; the
  multi-currency `/api/checkout` route uses `inflowCharges` on the core `mppx/server` instance.
- [`mpp-buyer-fetch`](./examples/mpp-buyer-fetch) — paying via MPP through a transparently polyfilled global `fetch`.
- [`mpp-buyer-manual`](./examples/mpp-buyer-manual) — paying via MPP through the explicit, non-polyfill `mppx.fetch`.

## Supported runtimes

Node 22 LTS or newer at runtime; the packages ship `engines.node: >=22.0.0`. CI exercises Node 22 (maintenance LTS until
April 2027) and Node 24 (active LTS, April 2028 EOL). Node 20 went EOL on 2026-04-30 and is no longer supported.

## Monorepo

For a tour of the monorepo itself — tooling, contributing, publishing — see [`docs/monorepo`](./docs/monorepo):

- [contributing](./docs/monorepo/contributing.md) — workflow, branch model, commit conventions.
- [tooling](./docs/monorepo/tooling.md) — pnpm, Turborepo, tsup, Vitest, MSW, ESLint, Prettier.
- [publishing](./docs/monorepo/publishing.md) — Changesets flow and npm provenance.
- [documentation](./docs/monorepo/documentation.md) — TSDoc, README, and `docs/` style guide.

## Security

See [SECURITY.md](./SECURITY.md) for disclosure. Examples under `examples/` are illustrative and out of scope.

## License

MIT.
