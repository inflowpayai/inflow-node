import bs58 from 'bs58';

const EXPECTED_LENGTH = 64;

export function decodeSolanaSecret(value: string): Uint8Array {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw invalidKey('input is empty');
  }
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw invalidKey(`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(parsed)) {
      throw invalidKey('JSON value is not an array');
    }
    if (parsed.length !== EXPECTED_LENGTH) {
      throw invalidKey(`JSON array length is ${parsed.length.toString()}, expected ${EXPECTED_LENGTH.toString()}`);
    }
    const bytes = new Uint8Array(EXPECTED_LENGTH);
    for (let i = 0; i < EXPECTED_LENGTH; i += 1) {
      const element = parsed[i];
      if (typeof element !== 'number' || !Number.isInteger(element) || element < 0 || element > 255) {
        throw invalidKey(`JSON array element at index ${i.toString()} is not an integer in 0..255`);
      }
      bytes[i] = element;
    }
    return bytes;
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(trimmed);
  } catch (err) {
    throw invalidKey(`base58 decode failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (decoded.length !== EXPECTED_LENGTH) {
    throw invalidKey(`base58 decoded to ${decoded.length.toString()} bytes, expected ${EXPECTED_LENGTH.toString()}`);
  }
  return decoded;
}

function invalidKey(reason: string): Error {
  return new Error(
    `Invalid Solana private key: ${reason}. Expected a 64-byte Ed25519 secret key, supplied either as a base58 string or a JSON byte array.`,
  );
}
