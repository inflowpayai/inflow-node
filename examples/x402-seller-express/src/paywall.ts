import 'dotenv/config';

import {
  createInflowFacilitator,
  createInflowHTTPResourceServer,
  createInflowResourceServer,
  createInflowSellerClient,
  inflowAccepts,
} from '@inflowpayai/x402-seller';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import { createPaywall } from '@x402/paywall';
import { evmPaywall } from '@x402/paywall/evm';
import express from 'express';

const apiKey = process.env['INFLOW_API_KEY'];
if (!apiKey) throw new Error('Set INFLOW_API_KEY to a sandbox Seller API key.');
const seller = await createInflowSellerClient({ environment: 'sandbox', apiKey });
const facilitator = createInflowFacilitator({ environment: 'sandbox', apiKey });
const server = await createInflowResourceServer(seller, facilitator);
const accepts = await inflowAccepts(seller, {
  price: '0.01 USDC',
  schemes: ['exact'],
  networks: ['eip155:84532'],
});
// The native browser checkout uses an external EVM wallet, not InFlow balance or Instrument payments.
const http = createInflowHTTPResourceServer(server, {
  'GET /report': { accepts, description: 'Sample sales report' },
});
http.registerPaywallProvider(
  createPaywall().withNetwork(evmPaywall).withConfig({ appName: 'Example reports', testnet: true }).build(),
);
const app = express();
app.use(paymentMiddlewareFromHTTPServer(http));
app.get('/report', (_request, response) => response.json({ report: 'Sample sales report' }));
const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () => {
  console.log(`Open http://localhost:${port.toString()}/report in a browser to view the native paywall.`);
  console.log('Completing checkout requires an external wallet funded with Base Sepolia test USDC.');
});
