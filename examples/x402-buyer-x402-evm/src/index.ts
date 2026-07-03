import 'dotenv/config';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const privateKey = process.env['EVM_PRIVATE_KEY'];
if (privateKey === undefined || privateKey === '') {
  console.error('Set EVM_PRIVATE_KEY in your environment (see .env.example).');
  process.exit(1);
}

const target = process.env['TARGET_URL'] ?? 'http://localhost:3000/api/widgets';

const account = privateKeyToAccount(normalizeEvmKey(privateKey));

const core = new x402Client();
registerExactEvmScheme(core, { signer: account, networks: ['eip155:84532'] });
const http = new x402HTTPClient(core);

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

function normalizeEvmKey(value: string): `0x${string}` {
  let hex = value.trim().toLowerCase();
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error('EVM_PRIVATE_KEY must be hex (0x-prefixed or bare).');
  }
  if (hex.length === 66 && hex.startsWith('00')) {
    hex = hex.slice(2);
  }
  if (hex.length < 64) hex = hex.padStart(64, '0');
  if (hex.length !== 64) {
    throw new Error(`EVM_PRIVATE_KEY must encode 32 bytes; got ${(hex.length / 2).toString()}.`);
  }
  return `0x${hex}`;
}
