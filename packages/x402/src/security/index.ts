import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string equality.
 *
 * @param a - First value. Anything other than a string returns `false`.
 * @param b - Second value. Anything other than a string returns `false`.
 * @returns `true` when both arguments are strings, have equal UTF-8 byte length, and have identical byte content. The
 *   comparison time does not depend on where the strings differ. Returns `false` otherwise.
 *
 *   Use for comparing opaque tokens such as payment identifiers and extension-supplied HMAC values where naive equality
 *   (`===`) could leak timing information.
 */
export function timingSafeEqualStrings(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
