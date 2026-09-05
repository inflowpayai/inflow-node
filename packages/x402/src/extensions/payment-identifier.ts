import { randomBytes } from 'node:crypto';

import type { DeclarationContext, ExtensionHandler } from './types.js';

/** Extension name on the wire — the key in `extensions[]` maps. */
export const EXTENSION_PAYMENT_IDENTIFIER = 'payment-identifier' as const;

export const PAYMENT_ID_MIN_LENGTH = 16;
export const PAYMENT_ID_MAX_LENGTH = 128;

const PAYMENT_ID_PATTERN = '^[a-zA-Z0-9_-]+$' as const;

/** Regex a valid payment identifier must match. Mirrors the x402 `payment-identifier` extension spec. */
export const PAYMENT_ID_REGEX = new RegExp(PAYMENT_ID_PATTERN, 'u');

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
  info: {
    /** Whether the payload must include an identifier. */
    required: boolean;
    [key: string]: unknown;
  };
  schema: PaymentIdentifierSchema;
}

/** Payload-entry shape attached to `PaymentPayload.extensions['payment-identifier']`. */
export interface PaymentIdentifierPayloadEntry {
  info: {
    /** The identifier value, satisfying {@link validatePaymentId}. */
    id: string;
    /** Whether the server requires an identifier. */
    required: boolean;
    [key: string]: unknown;
  };
  schema: PaymentIdentifierSchema;
}

export interface PaymentIdentifierSchema {
  [key: string]: unknown;
  $schema: 'https://json-schema.org/draft/2020-12/schema';
  type: 'object';
  properties: {
    id: { type: 'string'; minLength: 16; maxLength: 128; pattern: typeof PAYMENT_ID_PATTERN };
    required: { type: 'boolean' };
  };
  required: ['required'];
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
export const PAYMENT_IDENTIFIER = {
  name: EXTENSION_PAYMENT_IDENTIFIER,
  buildDeclaration(_context: DeclarationContext): PaymentIdentifierDeclaration {
    return { info: { required: false }, schema: paymentIdentifierSchema() };
  },
  readDeclaration(decl: unknown): PaymentIdentifierDeclaration | null {
    if (decl === null || typeof decl !== 'object') return null;
    const { info, schema } = decl as { info?: unknown; schema?: unknown };
    if (info === null || typeof info !== 'object' || !isPaymentIdentifierSchema(schema)) return null;
    const extensionInfo = info as Record<string, unknown>;
    const required = extensionInfo['required'];
    if (typeof required !== 'boolean') return null;
    return { info: { ...extensionInfo, required }, schema };
  },
  buildPayloadEntry(declaration, context): PaymentIdentifierPayloadEntry | null {
    const id = context.providedPaymentId;
    if (id === undefined) return null;
    if (!validatePaymentId(id)) return null;
    return {
      info: { ...declaration.info, id },
      schema: declaration.schema,
    };
  },
} satisfies ExtensionHandler<PaymentIdentifierDeclaration, PaymentIdentifierPayloadEntry>;

function isPaymentIdentifierSchema(value: unknown): value is PaymentIdentifierSchema {
  if (value === null || typeof value !== 'object') return false;
  const schema = value as {
    $schema?: unknown;
    type?: unknown;
    properties?: {
      id?: { type?: unknown; minLength?: unknown; maxLength?: unknown; pattern?: unknown };
      required?: { type?: unknown };
    };
    required?: unknown;
  };
  const properties = schema.properties;
  return (
    schema.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
    schema.type === 'object' &&
    properties !== undefined &&
    properties.id?.type === 'string' &&
    properties.id.minLength === PAYMENT_ID_MIN_LENGTH &&
    properties.id.maxLength === PAYMENT_ID_MAX_LENGTH &&
    properties.id.pattern === PAYMENT_ID_PATTERN &&
    properties.required?.type === 'boolean' &&
    Array.isArray(schema.required) &&
    schema.required.length === 1 &&
    schema.required[0] === 'required'
  );
}

function paymentIdentifierSchema(): PaymentIdentifierSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: PAYMENT_ID_MIN_LENGTH,
        maxLength: PAYMENT_ID_MAX_LENGTH,
        pattern: PAYMENT_ID_PATTERN,
      },
      required: { type: 'boolean' },
    },
    required: ['required'],
  };
}
