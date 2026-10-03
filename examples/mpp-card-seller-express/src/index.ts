import 'dotenv/config';

import { card } from '@inflowpayai/mpp-seller';
import express from 'express';
import { Mppx } from 'mppx/express';

const apiKey = process.env['INFLOW_API_KEY'];
const secretKey = process.env['MPP_SECRET_KEY'];
if (!apiKey || !secretKey) throw new Error('Set INFLOW_API_KEY and MPP_SECRET_KEY in .env.');

const payments = Mppx.create({
  methods: [await card({ apiKey, environment: 'sandbox' })],
  secretKey,
});
const app = express();
app.get(
  '/report',
  payments.charge({ amount: '1.00', description: 'Example report', scope: 'GET /report' }),
  (_request, response) => {
    response.json({ report: 'This resource was released after a successful CARD payment.' });
  },
);

const port = Number(process.env['PORT'] ?? '3000');
app.listen(port, () => console.log(`CARD seller listening at http://localhost:${String(port)}/report`));
