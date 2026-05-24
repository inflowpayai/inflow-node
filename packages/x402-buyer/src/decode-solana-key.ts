import bs58 from 'bs58';

import { X402InvalidSolanaKeyError } from './errors.js';

const EXPECTED_LENGTH = 64;

/**
 * Decode a Solana secret into the 64-byte Ed25519 form expected by `@solana/kit`'s `createKeyPairSignerFromBytes`.
 * Auto-detects between a JSON byte array (`[...]`, as written by `solana-keygen`) and base58 (as emitted by InFlow's
 * `SolanaClient.Account.getSeed()` and by Phantom's exported secret).
 *
 * @example
 *
 * ```ts
 * import { createKeyPairSignerFromBytes } from '@solana/kit';
 * import { decodeSolanaSecret } from '@inflowpayai/x402-buyer';
 *
 * const bytes = decodeSolanaSecret(process.env.SOLANA_PRIVATE_KEY!);
 * const signer = await createKeyPairSignerFromBytes(bytes);
 * ```
 *
 * @throws {@link X402InvalidSolanaKeyError} On empty input, unparseable payloads, or anything that doesn't decode to
 *   exactly 64 bytes.
 */
export function decodeSolanaSecret(value: string): Uint8Array {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new X402InvalidSolanaKeyError('input is empty');
  }
  if (trimmed.startsWith('[')) {
    return decodeJsonByteArray(trimmed);
  }
  return decodeBase58(trimmed);
}

function decodeJsonByteArray(trimmed: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new X402InvalidSolanaKeyError(`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new X402InvalidSolanaKeyError('JSON value is not an array');
  }
  if (parsed.length !== EXPECTED_LENGTH) {
    throw new X402InvalidSolanaKeyError(
      `JSON array length is ${parsed.length.toString()}, expected ${EXPECTED_LENGTH.toString()}`,
    );
  }
  const bytes = new Uint8Array(EXPECTED_LENGTH);
  for (let i = 0; i < EXPECTED_LENGTH; i += 1) {
    const element: unknown = parsed[i];
    if (typeof element !== 'number' || !Number.isInteger(element) || element < 0 || element > 255) {
      throw new X402InvalidSolanaKeyError(`JSON array element at index ${i.toString()} is not an integer in 0..255`);
    }
    bytes[i] = element;
  }
  return bytes;
}

function decodeBase58(trimmed: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(trimmed);
  } catch (err) {
    throw new X402InvalidSolanaKeyError(`base58 decode failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (decoded.length !== EXPECTED_LENGTH) {
    throw new X402InvalidSolanaKeyError(
      `base58 decoded to ${decoded.length.toString()} bytes, expected ${EXPECTED_LENGTH.toString()}`,
    );
  }
  return decoded;
}
