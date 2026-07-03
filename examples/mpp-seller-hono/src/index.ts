import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Mppx } from 'mppx/hono';
import { Mppx as MppxServer } from 'mppx/server';
import { inflow, inflowCharges } from '@inflowpayai/mpp-seller';

const apiKey = process.env['INFLOW_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}

// Build the `inflow` method (which primes `GET /v1/mpp/config` once) and the binding `secretKey` a single time, then
// stand up two instances over them — they expose different APIs:
//   - `mppx` (mppx/hono) wraps each method as a Hono `MiddlewareHandler` for ergonomic single-currency routes, but
//     the framework adapters strip `compose`.
//   - `core` (mppx/server) keeps `compose(...)`, which the multi-currency route below needs. Hono is fetch-native, so
//     we drive the helper's Web-fetch handler directly off `c.req.raw` and reflect its `{ status, challenge |
//     withReceipt }` result.
// `Mppx.create` only reads its argument, so sharing the method object is safe and avoids a second `/config` fetch.
// The `methods` array stays inline in each call so mppx can infer the precise method tuple (a hoisted config object
// would widen it and drop the typed handlers).
const method = inflow({ apiKey, environment: 'sandbox' });
const secretKey = process.env['MPP_SECRET_KEY'];
const mppx = Mppx.create({ methods: [method], secretKey });
const core = MppxServer.create({ methods: [method], secretKey });
const checkout = inflowCharges(core, [
  { amount: '1.0', currency: 'USD' },
  { amount: '0.0095', currency: 'USDC' },
]);

const app = new Hono();

// The rail is derived from the charge currency (crypto USDC → `balance`); the buyer never chooses it.
app.get('/api/widgets', mppx.charge({ amount: '0.01', currency: 'USDC' }), (c) => c.json({ widgets: [1, 2, 3] }));
app.post('/api/upload', mppx.charge({ amount: '0.10', currency: 'USDC' }), (c) => c.json({ status: 'received' }));

// Multi-currency: one WWW-Authenticate challenge per price (USD on `instrument`, USDC on `balance`). On 402 return
// the challenge response; on 200 wrap the body with the receipt header via `withReceipt`.
app.get('/api/checkout', async (c) => {
  const result = await checkout(c.req.raw);
  if (result.status === 402) {
    return result.challenge;
  }
  return result.withReceipt(c.json({ ok: true }));
});

app.get('/free', (c) => c.json({ ok: true, note: 'no payment required' }));

const port = Number(process.env['PORT'] ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`mpp seller listening on http://localhost:${port.toString()}`);
  console.log(`  GET  /api/widgets  (0.01 USDC, single currency)`);
  console.log(`  POST /api/upload   (0.10 USDC, single currency)`);
  console.log(`  GET  /api/checkout (1.0 USD on instrument, or 0.0095 USDC on balance)`);
  console.log(`  GET  /free         (no payment)`);
});
