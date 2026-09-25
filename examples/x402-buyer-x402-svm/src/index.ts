import 'dotenv/config';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { SOLANA_DEVNET_CAIP2 } from '@x402/svm';
import { registerExactSvmScheme } from '@x402/svm/exact/client';

import { decodeSolanaSecret } from './decode-svm-key.js';

/**
 * The buyer pays only in this mint. The seller's `accepts[]` typically advertises one entry per supported stablecoin
 * (USDC / USDT / PYUSD / …); without an explicit filter the foundation's default selector picks the first entry, which
 * may be a mint the buyer wallet has no ATA / balance for. Pinning the mint at the buyer is the right side of the
 * contract — the buyer knows which mints it holds, the seller doesn't.
 *
 * Default below is Circle's canonical devnet USDC. Override with `SOLANA_PAYMENT_MINT` when running against a sandbox
 * that uses a custom test mint (e.g. the InFlow sandbox issues its own USDC under a distinct mint authority).
 */
const DEFAULT_SOLANA_USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const paymentMint = process.env['SOLANA_PAYMENT_MINT'] ?? DEFAULT_SOLANA_USDC_MINT_DEVNET;
const maxAmount = process.env['SOLANA_MAX_AMOUNT_ATOMIC'];
if (paymentMint !== DEFAULT_SOLANA_USDC_MINT_DEVNET && maxAmount === undefined) {
  throw new Error('Set SOLANA_MAX_AMOUNT_ATOMIC when using a custom SOLANA_PAYMENT_MINT.');
}
if (maxAmount !== undefined && !/^[1-9][0-9]*$/.test(maxAmount)) {
  throw new Error("SOLANA_MAX_AMOUNT_ATOMIC must be a positive integer in the mint's smallest units.");
}

const privateKey = process.env['SOLANA_PRIVATE_KEY'];
if (privateKey === undefined || privateKey === '') {
  console.error('Set SOLANA_PRIVATE_KEY in your environment (see .env.example).');
  process.exit(1);
}

const target = process.env['TARGET_URL'] ?? 'http://localhost:3000/api/widgets';

const bytes = decodeSolanaSecret(privateKey);
const signer = await createKeyPairSignerFromBytes(bytes);

// Vanilla foundation x402 buyer — zero `@inflowpayai/*` imports. The
// point of this example is that an off-the-shelf x402 SVM client reads
// an InFlow-generated `accepts[]` the same way it reads any other
// foundation `accepts[]`.
//
// `SOLANA_DEVNET_CAIP2` is the genesis-hash-based CAIP-2 identifier
// (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) that `@x402/svm` ships as
// a named constant. The short alias `solana:devnet` is NOT a valid
// CAIP-2 namespace value and is rejected by the package's
// `normalizeNetwork`. EVM uses `eip155:<chainId>`; Solana uses
// `solana:<32-char-base58-genesis-hash>`.
const core = new x402Client();
registerExactSvmScheme(core, { signer, networks: [SOLANA_DEVNET_CAIP2] });
if (maxAmount !== undefined) {
  core.setSpendControls({
    allowedAssets: [{ network: SOLANA_DEVNET_CAIP2, asset: paymentMint, maxAmountPerPayment: maxAmount }],
  });
}

// Policies receive only requirements that pass the scheme and spend-control filters.
// Keep mint pinning separate: allowedAssets also permits foundation default assets.
core.registerPolicy((_x402Version, reqs) => {
  const kept = reqs.filter((r) => r.asset === paymentMint);
  console.log(
    `payment policy: ${reqs.length.toString()} requirements offered, ${kept.length.toString()} kept after mint filter (${paymentMint})`,
  );
  for (const r of reqs) {
    const keep = r.asset === paymentMint ? 'KEEP' : 'drop';
    console.log(
      `  ${keep} scheme=${r.scheme} network=${r.network} asset=${r.asset} amount=${r.amount} payTo=${r.payTo}`,
    );
  }
  return kept;
});

const http = new x402HTTPClient(core);

console.log(
  `payment mint pin: ${paymentMint}${process.env['SOLANA_PAYMENT_MINT'] === undefined ? ' (default Circle devnet USDC)' : ' (from SOLANA_PAYMENT_MINT)'}`,
);

// `paidFetch`: issue the request, parse the 402, sign, retry with the
// `X-PAYMENT` header. `getPaymentRequiredResponse` reads the `accepts[]`
// from the response headers (v2 of the protocol; the optional `body`
// arg is for v1 compatibility only).
async function paidFetch(url: string, init?: RequestInit): Promise<Response> {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n));
  const payload = await http.createPaymentPayload(required);
  const headers = http.encodePaymentSignatureHeader(payload);
  return fetch(url, { ...init, headers: { ...(init?.headers ?? {}), ...headers } });
}

console.log(`GET ${target}`);
const response = await paidFetch(target);
console.log(`  status: ${response.status.toString()}`);

const body = (await response.json()) as unknown;
console.log(`  body: ${JSON.stringify(body)}`);

const settleHeader = response.headers.get('x-payment-response');
if (settleHeader !== null && settleHeader !== '') {
  console.log(`  paid: ${settleHeader}`);
}
