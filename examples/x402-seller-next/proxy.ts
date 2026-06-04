import 'dotenv/config';
import { paymentProxyFromConfig } from '@x402/next';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '@inflowpayai/x402-seller';

const apiKey = process.env.INFLOW_API_KEY;
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}

// 1. Authed InFlow facilitator — `verify`, `settle`, `getSupported`.
//    Drops into the foundation's `facilitatorClients` array. The seller
//    can prepend or append other facilitators; first claimer of a
//    (scheme, network) pair via `getSupported()` wins routing.
const inflow = createInflowFacilitator({ environment: 'sandbox', apiKey });

// 2. Seller-authed client — owns `/v1/x402/config` and signer-discovery.
//    Module-top `await` so the cache prime runs once at the cold-start
//    boundary; subsequent proxy invocations on the same worker reuse
//    the warmed client.
const seller = await createInflowSellerClient({ environment: 'sandbox', apiKey });

// 3. Foundation proxy + InFlow-built `PaymentOption[]` entries.
//    `paymentProxyFromConfig` returns a `(req) => Promise<NextResponse>`
//    that we export as `proxy` (the Next 16 file-convention name —
//    `middleware.ts` was renamed to `proxy.ts` in Next 16).
//    `inflowAccepts` expands the seller's config into AssetAmount-form
//    `accepts[]` (atomic amount + asset contract address pre-resolved).
//    `inflowSchemeRegistrations` ships passthrough scheme servers so
//    `x402HTTPResourceServer.initialize()` sees a registered scheme for
//    every `(scheme, network)` the seller can emit — without these the
//    foundation aborts at boot with `RouteConfigurationError`.
//    Next 16's `proxy.ts` always runs on the Node.js runtime and does
//    not accept a `config` export — the function itself dispatches by
//    matching the request against the `routes` keys. `/free` is not in
//    that map, so the proxy passes it through to its Route Handler
//    untouched.
export const proxy = paymentProxyFromConfig(
  {
    'GET /api/widgets': {
      accepts: await inflowAccepts(seller, {
        price: '$0.01',
        schemes: ['exact'],
      }),
    },
    'POST /api/upload': {
      accepts: await inflowAccepts(seller, {
        price: '0.10 USDC',
        schemes: ['balance', 'exact'],
      }),
    },
  },
  [inflow],
  await inflowSchemeRegistrations(seller),
);
