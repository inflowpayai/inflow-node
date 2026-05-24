import 'dotenv/config';
import axios from 'axios';
import { createInflowClient } from '@inflowpayai/x402-buyer';
import { x402HTTPClient } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';

const apiKey = process.env.INFLOW_API_KEY;
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}

const target = process.env.TARGET_URL ?? 'http://localhost:3000/api/widgets';

// InflowClient extends @x402/core's x402Client. The factory primes the
// InFlow buyer capability cache before resolving, so the routing
// decision inside createPaymentPayload is synchronous against in-memory
// data. Foundation-managed schemes (registerExactEvmScheme, etc.) could
// be registered on `core` here for non-InFlow networks; this example
// targets an InFlow-acceptable resource and registers none.
const core = await createInflowClient({ apiKey, environment: 'sandbox' });
const http = new x402HTTPClient(core);

console.log(`GET ${target}`);

// Axios throws on non-2xx by default. Opt out via validateStatus so we
// can inspect the 402 ourselves.
const initial = await axios.get(target, { validateStatus: () => true });
if (initial.status !== 402) {
  console.log(`  status: ${initial.status.toString()}`);
  console.log(`  body: ${JSON.stringify(initial.data)}`);
  process.exit(0);
}

// Axios lowercases response header keys. Read the seller's PAYMENT-REQUIRED
// header, decode it with the foundation helper, drive InflowClient to sign,
// then replay with the PAYMENT-SIGNATURE header the foundation transport
// produces.
const paymentRequiredHeader = initial.headers['payment-required'];
if (typeof paymentRequiredHeader !== 'string') {
  console.error('  402 response missing PAYMENT-REQUIRED header');
  process.exit(1);
}
const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
const paymentPayload = await http.createPaymentPayload(paymentRequired);
const paymentHeaders = http.encodePaymentSignatureHeader(paymentPayload);

const paid = await axios.get(target, { headers: paymentHeaders });
console.log(`  status: ${paid.status.toString()}`);
console.log(`  body: ${JSON.stringify(paid.data)}`);

const paymentResponseHeader = paid.headers['payment-response'];
if (typeof paymentResponseHeader === 'string') {
  const settled = decodePaymentResponseHeader(paymentResponseHeader);
  console.log(`  paid via ${settled.network}: ${settled.transaction}`);
}
