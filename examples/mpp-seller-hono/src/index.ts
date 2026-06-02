import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Mppx } from 'mppx/hono';
import { inflow } from '@inflowpayai/mpp-seller';

const apiKey = process.env.INFLOW_API_KEY;
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}

// `mppx/hono`'s `Mppx.create` mints and HMAC-binds the challenge (`secretKey` read from `MPP_SECRET_KEY`; see the mppx
// docs); the InFlow `inflow` method's `verify` redeems and settles via the InFlow PSP. `mppx.charge(...)` returns a
// Hono `MiddlewareHandler`.
const mppx = Mppx.create({
  methods: [inflow({ apiKey, environment: 'sandbox' })],
  secretKey: process.env.MPP_SECRET_KEY,
});

const app = new Hono();

// The rail is derived from the charge currency (crypto USDC → `balance`); the buyer never chooses it.
app.get('/api/widgets', mppx.charge({ amount: '0.01', currency: 'USDC' }), (c) => c.json({ widgets: [1, 2, 3] }));
app.post('/api/upload', mppx.charge({ amount: '0.10', currency: 'USDC' }), (c) => c.json({ status: 'received' }));
app.get('/free', (c) => c.json({ ok: true, note: 'no payment required' }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`mpp seller listening on http://localhost:${port.toString()}`);
  console.log(`  GET  /api/widgets  (0.01 USDC)`);
  console.log(`  POST /api/upload   (0.10 USDC)`);
  console.log(`  GET  /free         (no payment)`);
});
