import 'dotenv/config';
import { createInflowClient } from '@inflowpayai/x402-buyer';
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
const initial = await fetch(target);
if (initial.status !== 402) {
  console.log(`  status: ${initial.status.toString()}`);
  console.log(`  body: ${await initial.text()}`);
  process.exit(0);
}

// Decode the seller's 402, drive InflowClient to sign, then replay with
// the PAYMENT-SIGNATURE header the foundation transport produces.
const paymentRequired = http.getPaymentRequiredResponse((name) => initial.headers.get(name));
const paymentPayload = await http.createPaymentPayload(paymentRequired);
const paymentHeaders = http.encodePaymentSignatureHeader(paymentPayload);

const paid = await fetch(target, { headers: paymentHeaders });

// processResponse parses the response body once and returns a
// discriminated outcome. `'success'` carries the parsed body and the
// settle response; other branches surface the failure mode.
const result = await http.processResponse(paid);
switch (result.kind) {
  case 'success':
    console.log(`  status: ${result.response.status.toString()}`);
    console.log(`  body: ${JSON.stringify(result.body)}`);
    console.log(`  paid via ${result.settleResponse.network}: ${result.settleResponse.transaction}`);
    break;
  case 'settle_failed':
    console.error(`  settle failed: ${result.settleResponse.errorReason ?? 'unknown'}`);
    process.exit(1);
  default:
    console.error(`  unexpected outcome: kind=${result.kind}`);
    process.exit(1);
}
