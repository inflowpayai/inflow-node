import 'dotenv/config';
import express from 'express';
import { Mppx } from 'mppx/express';
import { Mppx as MppxServer } from 'mppx/server';
import { inflow, inflowChargesNodeListener } from '@inflowpayai/mpp-seller';

const apiKey = process.env.INFLOW_API_KEY;
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}

// Build the `inflow` method (which primes `GET /v1/mpp/config` once) and the binding `secretKey` a single time, then
// stand up two instances over them — they expose different APIs:
//   - `mppx` (mppx/express) wraps each method as an Express `RequestHandler` for ergonomic single-currency routes,
//     but the framework adapters strip `compose`.
//   - `core` (mppx/server) keeps `compose(...)`, which the multi-currency route below needs; its handlers are
//     Web-fetch functions, bridged into Express with InFlow's `inflowChargesNodeListener` helper.
// `Mppx.create` only reads its argument, so sharing the method object is safe and avoids a second `/config` fetch.
// The `methods` array stays inline in each call so mppx can infer the precise method tuple (a hoisted config object
// would widen it and drop the typed handlers).
const method = inflow({ apiKey, environment: 'sandbox' });
const secretKey = process.env.MPP_SECRET_KEY;
const mppx = Mppx.create({ methods: [method], secretKey });
const core = MppxServer.create({ methods: [method], secretKey });

const app = express();
app.use(express.json());

// The rail is derived from the charge currency (crypto USDC → `balance`); the buyer never chooses it.
app.get('/api/widgets', mppx.charge({ amount: '0.01', currency: 'USDC' }), (_req, res) => {
  res.json({ widgets: [1, 2, 3] });
});

app.post('/api/upload', mppx.charge({ amount: '0.10', currency: 'USDC' }), (_req, res) => {
  res.json({ status: 'received' });
});

// Multi-currency: one WWW-Authenticate challenge per price. USD settles on the `instrument` rail, USDC on `balance`;
// the buyer picks one. `inflowChargesNodeListener` returns a Node listener, mountable directly in an Express route.
const checkout = inflowChargesNodeListener(core, [
  { amount: '1.0', currency: 'USD' },
  { amount: '0.0095', currency: 'USDC' },
]);
app.get('/api/checkout', async (req, res) => {
  // On 402 the challenge response is already written; on 200 the receipt header is set, so we write the body.
  const result = await checkout(req, res);
  if (result.status === 402) {
    return;
  }
  res.json({ ok: true });
});

app.get('/free', (_req, res) => {
  res.json({ ok: true, note: 'no payment required' });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`mpp seller listening on http://localhost:${port.toString()}`);
  console.log(`  GET  /api/widgets  (0.01 USDC, single currency)`);
  console.log(`  POST /api/upload   (0.10 USDC, single currency)`);
  console.log(`  GET  /api/checkout (1.0 USD on instrument, or 0.0095 USDC on balance)`);
  console.log(`  GET  /free         (no payment)`);
});
