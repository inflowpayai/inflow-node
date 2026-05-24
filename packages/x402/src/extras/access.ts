/**
 * Read a typed entry from an `extra` map (the open-ended record carried on `PaymentRequirements.extra`,
 * `PaymentMethodInfo.extra`, and similar).
 *
 * @typeParam T - Caller-supplied expected type of the value. The function does **not** validate at runtime; callers
 *   must narrow defensively.
 * @param extra - The `extra` record, or `undefined`.
 * @param key - Key to read.
 * @returns The raw value cast to `T`, or `undefined` if absent.
 */
export function getExtra<T = unknown>(
  extra: Readonly<Record<string, unknown>> | undefined,
  key: string,
): T | undefined {
  if (extra === undefined) return undefined;
  const value = extra[key];
  if (value === undefined) return undefined;
  return value as T;
}

/**
 * Return a new `extra` map with `key` set to `value`. Never mutates the input.
 *
 * @typeParam T - Type of the value being written.
 * @param extra - The existing `extra` record, or `undefined` to start from empty.
 * @param key - Key to write.
 * @param value - Value to associate with `key`.
 * @returns A new record with `value` set at `key`.
 */
export function setExtra<T>(
  extra: Readonly<Record<string, unknown>> | undefined,
  key: string,
  value: T,
): Record<string, unknown> {
  return { ...(extra ?? {}), [key]: value };
}
