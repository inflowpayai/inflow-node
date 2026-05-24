import { randomBytes } from 'node:crypto';

import type { ExtensionHandler } from './types.js';

/** Extension name on the wire — the key in `extensions[]` maps. */
export const EXTENSION_PAYMENT_IDENTIFIER = 'payment-identifier' as const;

export const PAYMENT_ID_MIN_LENGTH = 16;
export const PAYMENT_ID_MAX_LENGTH = 128;

/** Regex a valid payment identifier must match. Mirrors the x402 `payment-identifier` extension spec. */
export const PAYMENT_ID_REGEX = /^[a-zA-Z0-9_-]+$/u;

/**
 * Regex a {@link generatePaymentId} prefix must match — same character class as {@link PAYMENT_ID_REGEX}, but allows the
 * empty string.
 */
const PAYMENT_ID_PREFIX_REGEX = /^[a-zA-Z0-9_-]*$/u;

/**
 * Default prefix used by {@link generatePaymentId}. Mirrors the format produced by InFlow's automatic
 * transaction-id-derived identifiers (`pay_<32 hex chars>`).
 */
export const PAYMENT_ID_DEFAULT_PREFIX = 'pay_';

/** Declaration shape attached to `PaymentRequired.extensions['payment-identifier']`. */
export interface PaymentIdentifierDeclaration {
  /**
   * When `true`, the payload's `extensions['payment-identifier'].paymentId` is mandatory; settlement fails without it.
   * When `false`, the field is optional and may be omitted.
   */
  required: boolean;
}

/** Payload-entry shape attached to `PaymentPayload.extensions['payment-identifier']`. */
export interface PaymentIdentifierPayloadEntry {
  /** The identifier value, satisfying {@link validatePaymentId}. */
  paymentId: string;
}

/**
 * Validate a payment-identifier string against the extension spec.
 *
 * @param id - Candidate identifier. Returns `false` for any non-string input.
 * @returns `true` when `id` is a string of length 16–128 containing only `a–z`, `A–Z`, `0–9`, `_`, and `-`. `false`
 *   otherwise.
 */
export function validatePaymentId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length < PAYMENT_ID_MIN_LENGTH || id.length > PAYMENT_ID_MAX_LENGTH) return false;
  return PAYMENT_ID_REGEX.test(id);
}

/**
 * Generate a new payment identifier.
 *
 * @param prefix - String prefix prepended to a random 32-character hex suffix. Defaults to `'pay_'`. Must satisfy
 *   `^[a-zA-Z0-9_-]*$` and yield a total length of 16–128 when combined with the suffix.
 * @returns A string of the form `<prefix><32 hex chars>` (lowercase).
 * @throws {Error} When `prefix` contains characters not allowed by {@link PAYMENT_ID_REGEX} or the resulting identifier
 *   falls outside the 16–128-character bound.
 */
export function generatePaymentId(prefix: string = PAYMENT_ID_DEFAULT_PREFIX): string {
  if (typeof prefix !== 'string' || !PAYMENT_ID_PREFIX_REGEX.test(prefix)) {
    throw new Error(`generatePaymentId: prefix "${prefix}" contains characters outside ${PAYMENT_ID_REGEX.source}`);
  }
  const suffix = randomBytes(16).toString('hex');
  const id = `${prefix}${suffix}`;
  if (id.length < PAYMENT_ID_MIN_LENGTH || id.length > PAYMENT_ID_MAX_LENGTH) {
    throw new Error(
      `generatePaymentId: result length ${id.length} is outside [${PAYMENT_ID_MIN_LENGTH}, ${PAYMENT_ID_MAX_LENGTH}]`,
    );
  }
  return id;
}

/**
 * Handler for the x402 `payment-identifier` extension. Used by the seller (`inflowAccepts`) and the buyer (signer flows
 * that compose external `x402Client` signers).
 */
export const PAYMENT_IDENTIFIER: ExtensionHandler<PaymentIdentifierDeclaration, PaymentIdentifierPayloadEntry> = {
  name: EXTENSION_PAYMENT_IDENTIFIER,
  buildDeclaration(): PaymentIdentifierDeclaration {
    return { required: false };
  },
  readDeclaration(decl: unknown): PaymentIdentifierDeclaration | null {
    if (decl === null || typeof decl !== 'object') return null;
    const required = (decl as { required?: unknown }).required;
    if (typeof required !== 'boolean') return null;
    return { required };
  },
  buildPayloadEntry(_declaration, context): PaymentIdentifierPayloadEntry | null {
    const id = context.providedPaymentId;
    if (id === undefined) return null;
    if (!validatePaymentId(id)) return null;
    return { paymentId: id };
  },
};
