import 'dotenv/config';
import { Mppx, inflow, Receipt } from '@inflowpayai/mpp-buyer';

const apiKey = process.env['INFLOW_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}

const target = process.env['TARGET_URL'] ?? 'http://localhost:3000/api/widgets';
const baseUrl = process.env['INFLOW_BASE_URL'];
const instrumentId = process.env['INSTRUMENT_ID'];

// `polyfill: false` leaves `globalThis.fetch` untouched; payment happens only through the returned `mppx.fetch`.
const mppx = Mppx.create({
  maxPaymentRetries: 1,
  polyfill: false,
  methods: [
    inflow({ apiKey, environment: 'sandbox', ...(baseUrl === undefined || baseUrl === '' ? {} : { baseUrl }) }),
  ],
});

console.log(`GET ${target}`);
const res = await mppx.fetch(target, {
  context: instrumentId === undefined || instrumentId === '' ? {} : { instrumentId },
});
console.log(`  status: ${res.status.toString()}`);
console.log(`  body: ${await res.text()}`);

// `Receipt.fromResponse` throws when no `Payment-Receipt` header is present, so only read it on a paid response.
if (res.ok) {
  const receipt = Receipt.fromResponse(res);
  console.log(`  paid via ${receipt.method}: ${receipt.reference}`);
} else {
  process.exitCode = 1;
}
