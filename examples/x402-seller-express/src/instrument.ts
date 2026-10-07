import 'dotenv/config';
import { paymentMiddlewareFromConfig } from '@x402/express';
import express from 'express';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '@inflowpayai/x402-seller';

const apiKey = process.env['INFLOW_API_KEY'];
if (apiKey === undefined || apiKey === '') throw new Error('Set INFLOW_API_KEY to a sandbox seller key.');
const options = { environment: 'sandbox' as const, apiKey };
const seller = await createInflowSellerClient(options);
const schemes = ['instrument'];
const accepts = await inflowAccepts(seller, { price: '$1.00', schemes });
if (accepts.length === 0) {
  throw new Error('Instrument payments are unavailable. Connect a Stripe account in your sandbox seller dashboard.');
}

const app = express();
app.use(
  paymentMiddlewareFromConfig(
    { 'GET /api/report': { accepts } },
    [createInflowFacilitator(options)],
    await inflowSchemeRegistrations(seller, { schemes }),
  ),
);
app.get('/api/report', (_request, response) => response.json({ report: 'Example report' }));
const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () =>
  console.log(`Instrument seller listening at http://localhost:${port.toString()}/api/report (USD 1.00)`),
);
