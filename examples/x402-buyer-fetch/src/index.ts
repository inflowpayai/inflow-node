import 'dotenv/config';
import { createInflowClient } from '@inflowpayai/x402-buyer';
import { sellerProbe } from '@inflowpayai/x402-buyer/probe';
import { x402HTTPClient } from '@x402/core/client';

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
// `sellerProbe` from the buyer's /probe subpath is a thin `fetch`
// wrapper that captures status + headers + raw bytes without trying to
// interpret the body. Convenient when the same response will be
// inspected for a PAYMENT-REQUIRED header or replayed with a signed
// payload — both branches need the same metadata.
const initial = await sellerProbe(target, { method: 'GET', headers: {} });
if (initial.status !== 402) {
  console.log(`  status: ${initial.status.toString()}`);
  console.log(`  body: ${new TextDecoder().decode(initial.bytes)}`);
  process.exit(0);
}

// Decode the seller's 402, drive InflowClient to sign, then replay with
// the PAYMENT-SIGNATURE header the foundation transport produces.
const paymentRequired = http.getPaymentRequiredResponse((name) => initial.headers.get(name));
const paymentPayload = await http.createPaymentPayload(paymentRequired);
const paymentHeaders = http.encodePaymentSignatureHeader(paymentPayload);

const paid = await fetch(target, { headers: paymentHeaders });

// The settlement rides in the `PAYMENT-RESPONSE` (legacy `X-PAYMENT-RESPONSE`)
// header, decoded by `getPaymentSettleResponse`; the HTTP status is on the
// native `Response`.
const getHeader = (name: string): string | null => paid.headers.get(name);
const hasSettleHeader = getHeader('PAYMENT-RESPONSE') !== null || getHeader('X-PAYMENT-RESPONSE') !== null;

console.log(`  status: ${paid.status.toString()}`);
console.log(`  body: ${await paid.text()}`);

if (!hasSettleHeader) {
  // `getPaymentSettleResponse` throws without a settlement header, so surface
  // the unexpected outcome (e.g. a repeated 402) instead of decoding.
  console.error(`  unexpected outcome: no settlement header (status ${paid.status.toString()})`);
  process.exit(1);
}

const settle = http.getPaymentSettleResponse(getHeader);
if (settle.success) {
  console.log(`  paid via ${settle.network}: ${settle.transaction}`);
} else {
  console.error(`  settle failed: ${settle.errorReason ?? 'unknown'}`);
  process.exit(1);
}
