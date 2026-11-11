import 'dotenv/config';
import { paymentProxyFromHTTPServer } from '@x402/next';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  createInflowResourceServer,
  createInflowHTTPResourceServer,
} from '@inflowpayai/x402-seller';

const apiKey = process.env['INFLOW_API_KEY'];
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

const resourceServer = await createInflowResourceServer(seller, inflow);
export const proxy = paymentProxyFromHTTPServer(
  createInflowHTTPResourceServer(resourceServer, {
    'GET /api/widgets': async (context) => ({
      accepts: await inflowAccepts(seller, {
        price: context.adapter.getQueryParam?.('bundle') === 'large' ? '$0.05' : '$0.01',
        schemes: ['exact'],
      }),
    }),
    'POST /api/upload': async (context) => ({
      accepts: await inflowAccepts(seller, {
        price: context.adapter.getQueryParam?.('priority') === 'high' ? '0.20 USDC' : '0.10 USDC',
        schemes: ['balance', 'exact'],
      }),
    }),
  }),
);
