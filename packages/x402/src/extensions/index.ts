import type { ExtensionHandler } from './types.js';
import { PAYMENT_IDENTIFIER } from './payment-identifier.js';

export type { DeclarationContext, ExtensionHandler, SignContext } from './types.js';
export { getExtension, setExtension } from './access.js';
export {
  EXTENSION_PAYMENT_IDENTIFIER,
  PAYMENT_ID_DEFAULT_PREFIX,
  PAYMENT_ID_MAX_LENGTH,
  PAYMENT_ID_MIN_LENGTH,
  PAYMENT_ID_REGEX,
  PAYMENT_IDENTIFIER,
  generatePaymentId,
  validatePaymentId,
} from './payment-identifier.js';
export type { PaymentIdentifierDeclaration, PaymentIdentifierPayloadEntry } from './payment-identifier.js';

// Source list for EXTENSION_REGISTRY below. Kept module-local: there's no public reason for consumers to iterate
// "all extensions" — they look up handlers by name via EXTENSION_REGISTRY, or by importing the named handler module
// directly. Add new extension handlers here when adding a handler module.
const ALL_EXTENSIONS: readonly ExtensionHandler<unknown, unknown>[] = [PAYMENT_IDENTIFIER];

/**
 * Lookup table keyed by extension name. Used by the seller (`inflowAccepts`) and the buyer signer to dispatch declared
 * extensions to their handlers. Names without a registered handler are forwarded verbatim by the callers so out-of-band
 * extensions still reach the wire.
 */
export const EXTENSION_REGISTRY: ReadonlyMap<string, ExtensionHandler<unknown, unknown>> = new Map(
  ALL_EXTENSIONS.map((h) => [h.name, h]),
);
