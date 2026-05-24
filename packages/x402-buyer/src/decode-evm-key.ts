import { X402InvalidEvmKeyError } from './errors.js';

const HEX_RE = /^[0-9a-f]+$/;

/**
 * Normalize a secp256k1 secret to viem's `0x`-prefixed 32-byte hex form. Accepts `0x`-prefixed hex, bare hex, or an
 * InFlow Java seed (`BigInteger.toByteArray()` output — two's-complement, so 33 bytes with a leading sign byte for
 * high-bit-set secrets, or short when leading zero bytes were dropped). Both edges renormalize to 32 bytes.
 *
 * @example
 *
 * ```ts
 * import { privateKeyToAccount } from 'viem/accounts';
 * import { parseEvmPrivateKey } from '@inflowpayai/x402-buyer';
 *
 * const account = privateKeyToAccount(parseEvmPrivateKey(process.env.EVM_PRIVATE_KEY!));
 * ```
 *
 * @throws {@link X402InvalidEvmKeyError} On non-hex input or a payload that doesn't reduce to exactly 32 bytes.
 */
export function parseEvmPrivateKey(value: string): `0x${string}` {
  let hex = value.trim().toLowerCase();
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex === '' || !HEX_RE.test(hex)) {
    throw new X402InvalidEvmKeyError('expected hex characters (0x-prefixed or bare)');
  }
  // Strip the Java BigInteger sign byte: a 33-byte two's-complement
  // encoding of a positive secp256k1 secret whose top byte is >= 0x80.
  if (hex.length === 66 && hex.startsWith('00')) {
    hex = hex.slice(2);
  }
  // Left-pad short keys whose leading zero bytes were dropped by
  // `BigInteger.toByteArray()`.
  if (hex.length < 64) hex = hex.padStart(64, '0');
  if (hex.length !== 64) {
    throw new X402InvalidEvmKeyError(`expected 32 bytes after normalization; got ${(hex.length / 2).toString()}`);
  }
  return `0x${hex}`;
}
