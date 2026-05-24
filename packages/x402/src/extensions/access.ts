import type { ExtensionHandler } from './types.js';

/**
 * Read a typed extension entry from an `extensions` map.
 *
 * @typeParam TDecl - Shape of the parsed declaration the handler returns.
 * @param extensions - The `extensions` record from `PaymentRequired` (or any equivalent shape). `undefined` is treated
 *   as an empty map.
 * @param handler - The {@link ExtensionHandler} that knows how to parse the entry for its own `name`.
 * @returns The parsed declaration, or `undefined` if the entry is missing or didn't match the handler's expected shape.
 */
export function getExtension<TDecl>(
  extensions: Readonly<Record<string, unknown>> | undefined,
  handler: ExtensionHandler<TDecl, unknown>,
): TDecl | undefined {
  if (extensions === undefined) return undefined;
  const raw = extensions[handler.name];
  if (raw === undefined) return undefined;
  return handler.readDeclaration(raw) ?? undefined;
}

/**
 * Return a new `extensions` map with the handler's entry set to `value`. Never mutates the input.
 *
 * @typeParam TDecl - Shape of the declaration being written.
 * @param extensions - The existing `extensions` record, or `undefined` to start from empty.
 * @param handler - The handler whose `name` keys the entry.
 * @param value - The declaration value to write.
 * @returns A new record with `value` set under `handler.name`.
 */
export function setExtension<TDecl>(
  extensions: Readonly<Record<string, unknown>> | undefined,
  handler: ExtensionHandler<TDecl, unknown>,
  value: TDecl,
): Record<string, unknown> {
  return { ...(extensions ?? {}), [handler.name]: value };
}
