import 'dotenv/config';
import type { RouteConfig } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddlewareFromConfig } from '@x402/express';
import type { SchemeRegistration } from '@x402/express';
import express from 'express';
import { createUnauthenticatedInflowFacilitator } from '@inflowpayai/x402-seller';

const sellerAddress = process.env.SELLER_EVM_ADDRESS;
if (sellerAddress === undefined || sellerAddress === '') {
  console.error('Set SELLER_EVM_ADDRESS in your environment (see .env.example).');
  process.exit(1);
}

// The only InFlow piece in this seller. The rest is a vanilla
// `@x402/express` server. `createUnauthenticatedInflowFacilitator`
// returns a foundation `FacilitatorClient` (`verify` / `settle` /
// `getSupported`) that issues no `X-API-KEY` header on outbound
// requests — the InFlow facilitator is operating in its public,
// self-hosted-style mode here, with no per-seller InFlow account
// attached. The foundation middleware treats it as just another
// facilitator entry. No `inflowAccepts`, no `inflowSchemeRegistrations`
// — the seller hand-builds the `accepts[]` array against Base Sepolia
// USDC, the same way a seller using the foundation's reference
// facilitator would.
const inflow = createUnauthenticatedInflowFacilitator({ environment: 'sandbox' });

// Base Sepolia USDC, hand-built `RouteConfig`. The atomic-amount and
// asset contract address are pre-resolved here in `price` (the
// AssetAmount form) rather than sourced from the seller's InFlow
// config — this proves InFlow's facilitator is a faithful drop-in for
// the foundation's `FacilitatorClient` contract when the seller
// chooses not to use any other InFlow helpers.
//
// `resource`, `description`, `mimeType` sit on the `RouteConfig` itself,
// alongside `accepts`. The foundation's middleware copies them onto
// every generated `PaymentRequirements` entry at 402 emission time.
// Explicitly typed as `RouteConfig` so the contextual type propagates
// to each field — without this, TypeScript widens the inline object
// literal's `network` from the `eip155:84532` string-literal to plain
// `string`, which fails to match `Network = ${string}:${string}` and
// surfaces as a confusing "Type 'string' is not assignable to
// '${string}:${string}'" error.
const widgetsRoute: RouteConfig = {
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:84532',
      payTo: sellerAddress,
      price: {
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia USDC
        amount: '10000', // 0.01 USDC, 6 decimals
      },
      maxTimeoutSeconds: 60,
      // The foundation `@x402/evm` exact-client builds an EIP-712 typed-data
      // payload for the EIP-3009 `transferWithAuthorization` call. The
      // domain separator requires the token contract's exact `name()` and
      // `version()` values; the foundation rejects the buyer-side signing
      // path with "EIP-712 domain parameters (name, version) are required"
      // if these are missing from the `extra` bag. For Base Sepolia USDC
      // at `0x036CbD…`, the on-chain contract reads `name() = "USDC"` and
      // `version() = "2"` (Base mainnet USDC differs — it reads "USD
      // Coin" — so testnet/mainnet are NOT interchangeable here).
      extra: {
        name: 'USDC',
        version: '2',
      },
    },
  ],
  resource: 'http://localhost:3000/api/widgets',
  description: 'Sample protected resource',
  mimeType: 'application/json',
};

// The foundation middleware's `x402HTTPResourceServer.initialize()` requires
// a registered `SchemeNetworkServer` for every `(scheme, network)` pair
// declared on a route — otherwise it bails at boot with
// `RouteConfigurationError: No scheme implementation registered`. The
// InFlow seller examples source this list from `inflowSchemeRegistrations(seller)`,
// but this example has no seller client; we hand-register the foundation's
// `ExactEvmScheme` for Base Sepolia directly. That's the symmetric piece
// to the buyer's `registerExactEvmScheme(core, { signer, networks: ['eip155:84532'] })`.
const schemes: SchemeRegistration[] = [{ network: 'eip155:84532', server: new ExactEvmScheme() }];

const app = express();
app.use(express.json());
app.use(paymentMiddlewareFromConfig({ 'GET /api/widgets': widgetsRoute }, [inflow], schemes));
app.get('/api/widgets', (_req, res) => {
  res.json({ widgets: [1, 2, 3] });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`x402 facilitator-example seller listening on http://localhost:${port.toString()}`);
  console.log(
    `  GET /api/widgets  — 402 protected (0.01 USDC on eip155:84532; verify+settle delegated to the unauthenticated InFlow facilitator)`,
  );
});
