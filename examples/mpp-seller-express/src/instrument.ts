import 'dotenv/config';
import express from 'express';
import { Mppx } from 'mppx/express';
import { inflow } from '@inflowpayai/mpp-seller';

const apiKey = process.env['INFLOW_API_KEY'];
if (apiKey === undefined || apiKey === '') throw new Error('Set INFLOW_API_KEY to a sandbox seller key.');
const baseUrl = process.env['INFLOW_BASE_URL'];
const mppx = Mppx.create({
  methods: [
    inflow({
      apiKey,
      environment: 'sandbox',
      ...(baseUrl === undefined || baseUrl === '' ? {} : { baseUrl }),
    }),
  ],
  secretKey: process.env['MPP_SECRET_KEY'],
});

const app = express();
app.get(
  '/api/report',
  mppx.charge({ amount: '1.00', currency: 'USD', methodDetails: { rail: 'instrument' } }),
  (_request, response) => response.json({ report: 'Example report' }),
);
const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () =>
  console.log(`Instrument seller listening at http://localhost:${port.toString()}/api/report (USD 1.00)`),
);
