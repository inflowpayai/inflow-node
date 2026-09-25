import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const example = resolve(import.meta.dirname, '../examples/x402-buyer-x402-svm');
const standardMint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const customMint = 'So11111111111111111111111111111111111111112';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const secret = JSON.stringify([
  ...privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
  ...publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
]);

async function runExample(settings, response) {
  let requests = 0;
  const server = createServer((_request, reply) => {
    requests += 1;
    if (response !== undefined) {
      reply.writeHead(402, { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(response)).toString('base64') });
    } else {
      reply.writeHead(200, { 'content-type': 'application/json' });
    }
    reply.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const env = { ...process.env };
  delete env.SOLANA_PAYMENT_MINT;
  delete env.SOLANA_MAX_AMOUNT_ATOMIC;
  try {
    let result;
    try {
      result = await run(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
        cwd: example,
        timeout: 15000,
        env: {
          ...env,
          DOTENV_CONFIG_PATH: resolve(example, 'test-no-env-file'),
          SOLANA_PRIVATE_KEY: secret,
          TARGET_URL: `http://127.0.0.1:${address.port}/resource`,
          ...settings,
        },
      });
    } catch (error) {
      result = error;
    }
    return { result, requests };
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  }
}

function challenge(asset, amount) {
  return {
    x402Version: 2,
    resource: { url: 'http://localhost/resource', description: 'Test', mimeType: 'application/json' },
    accepts: [
      {
        scheme: 'exact',
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        asset,
        amount,
        payTo: customMint,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
}

test('Solana example requires an explicit custom-mint cap before requesting a resource', async () => {
  const { result, requests } = await runExample({ SOLANA_PAYMENT_MINT: customMint });
  assert.match(result.stderr, /Set SOLANA_MAX_AMOUNT_ATOMIC/);
  assert.equal(requests, 0);
});

for (const amount of ['', '0', '-1', '1.5', '1e6']) {
  test(`Solana example rejects invalid atomic cap ${JSON.stringify(amount)}`, async () => {
    const { result, requests } = await runExample({ SOLANA_MAX_AMOUNT_ATOMIC: amount });
    assert.match(result.stderr, /must be a positive integer/);
    assert.equal(requests, 0);
  });
}

test('Solana example starts with the default mint or an explicitly capped custom mint', async () => {
  for (const settings of [{}, { SOLANA_PAYMENT_MINT: customMint, SOLANA_MAX_AMOUNT_ATOMIC: '1000000' }]) {
    const { result, requests } = await runExample(settings);
    assert.equal(result.code, undefined, result.stderr);
    assert.equal(requests, 1);
  }
});

test('Solana example rejects over-limit payments through the real foundation scheme before signing', async () => {
  for (const [settings, asset] of [
    [{}, standardMint],
    [{ SOLANA_PAYMENT_MINT: customMint, SOLANA_MAX_AMOUNT_ATOMIC: '1000000' }, customMint],
  ]) {
    const { result, requests } = await runExample(settings, challenge(asset, '1000001'));
    assert.match(result.stderr, /rejected by spendControls/);
    assert.equal(requests, 1);
  }
});
