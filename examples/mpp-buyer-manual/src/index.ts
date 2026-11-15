import 'dotenv/config';
import { Mppx, inflow, Receipt } from '@inflowpayai/mpp-buyer';
import { Fetch } from 'mppx/client';

const apiKey = process.env['INFLOW_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}

const target = process.env['TARGET_URL'] ?? 'http://localhost:3000/api/widgets';
const baseUrl = process.env['INFLOW_BASE_URL'];
const instrumentId = process.env['INSTRUMENT_ID'];
const inspectOnly = process.argv.includes('--inspect');

// `polyfill: false` leaves `globalThis.fetch` untouched; payment happens only through the returned `mppx.fetch`.
const mppx = Mppx.create({
  maxPaymentRetries: 1,
  polyfill: false,
  methods: [
    inflow({ apiKey, environment: 'sandbox', ...(baseUrl === undefined || baseUrl === '' ? {} : { baseUrl }) }),
  ],
});

console.log(`GET ${target}`);
const res = await mppx.fetch(
  target,
  inspectOnly
    ? Fetch.withoutPayment()
    : { context: instrumentId === undefined || instrumentId === '' ? {} : { instrumentId } },
);
console.log(`  status: ${res.status.toString()}`);
console.log(`  body: ${await res.text()}`);

// A successful free response has no payment receipt.
if (res.ok && res.headers.has('Payment-Receipt')) {
  const receipt = Receipt.fromResponse(res);
  console.log(`  paid via ${receipt.method}: ${receipt.reference}`);
} else if (!inspectOnly && !res.ok) {
  process.exitCode = 1;
}
