import 'dotenv/config';
import { createHash } from 'node:crypto';

import { paymentMiddlewareFromConfig, setSettlementOverrides } from '@x402/express';
import express from 'express';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '@inflowpayai/x402-seller';

const apiKey = process.env['INFLOW_API_KEY'];
if (!apiKey) throw new Error('Set INFLOW_API_KEY to a sandbox seller key.');
const options = { environment: 'sandbox' as const, apiKey };
const seller = await createInflowSellerClient(options);
const schemes = ['upto'];
const accepts = await inflowAccepts(seller, { price: '0.10 USDC', schemes });
if (accepts.length === 0) throw new Error('The seller configuration does not advertise upto for USDC.');

const app = express();
app.use(express.text({ type: 'text/plain', limit: 100000 }));
app.use(
  paymentMiddlewareFromConfig(
    { 'POST /api/hash': { accepts } },
    [createInflowFacilitator(options)],
    await inflowSchemeRegistrations(seller, { schemes }),
  ),
);
app.post('/api/hash', (request, response) => {
  const input: unknown = request.body;
  if (typeof input !== 'string') {
    response.status(400).json({ error: 'Send a text/plain body.' });
    return;
  }
  const bytes = Buffer.byteLength(input, 'utf8');
  // One atomic USDC unit per input byte; the parser bounds usage by the authorized 100000-unit ceiling.
  setSettlementOverrides(response, { amount: bytes.toString() });
  response.json({ sha256: createHash('sha256').update(input).digest('hex'), bytes });
});
const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () => console.log(`Metered seller listening on http://localhost:${port.toString()}/api/hash`));
