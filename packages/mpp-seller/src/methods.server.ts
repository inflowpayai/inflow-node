import { randomUUID } from 'node:crypto';

import {
  charge as inflowCharge,
  encode,
  MppClient,
  PROBLEM_TYPES,
  subscription as inflowSubscription,
  tempoCharge,
} from '@inflowpayai/mpp';
import { UNSAFE_OBJECT_KEYS, sanitizeJsonValue } from '@inflowpayai/mpp-internal';
import type {
  InflowChargeRequestInput,
  MppChallenge,
  MppBroadcastRequest,
  MppCredential,
  MppProblemDetail,
  MppReceipt,
  MppRequestOptions,
  TempoChargeRequestInput,
} from '@inflowpayai/mpp';
import { Method, Receipt } from 'mppx';
import type { Credential } from 'mppx';

import { createConfigClient } from './config-client.js';
import {
  MppAmbiguousRailError,
  MppInstrumentRequiredError,
  MppCredentialProblemError,
  MppUnsupportedCurrencyError,
  MppUnsupportedRailError,
} from './errors.js';
import type { InflowSellerParameters, LoadedConfig, TempoSellerParameters } from './types.js';

const MAX_RECEIPT_EXTENSION_DEPTH = 16;
const MAX_RECEIPT_EXTENSION_ENTRIES = 256;
const MAX_RECEIPT_EXTENSIONS_LENGTH = 16_384;
const RECEIPT_EXTENSION_KEYS: ReadonlySet<string> = new Set([
  'challengeId',
  'challenge',
  'extensions',
  'method',
  'reference',
  'settlement',
  'status',
  'timestamp',
]);

/** The resolved `methodDetails` selector the request hook attaches: rail (derived from currency) + optional instrument. */
interface ResolvedMethodDetails {
  rail: 'balance' | 'instrument';
  instrumentId?: string;
}

/**
 * The seller-side `inflow` method, built as a **native mppx server method**. `Mppx.create({ methods: [inflow(...)],
 * secretKey }).charge({ amount })` mints and HMAC-binds the `WWW-Authenticate: Payment` challenge **locally** with the
 * seller's `secretKey`; this factory supplies deterministic request enrichment, binding fields, non-mutating
 * validation, and authoritative broadcast through the InFlow PSP.
 *
 * The flow is the exact analog of `@inflowpayai/x402-seller` delegating verify/settle to the InFlow facilitator while
 * the foundation SDK owns the wire mechanics:
 *
 * - **`defaults`** pin the seller's `currency` so `charge({ amount })` need not repeat it.
 * - **`request`** is a _pure_ function of the request + cached `/config`: it sets the `recipient` to the authenticated
 *   seller (the config's `sellerId`) and selects a rail advertised for the request's intent and currency, failing fast
 *   for unsupported or ambiguous capabilities. Purity is required — mppx re-derives the request at verify, and a
 *   non-deterministic hook would trip the binding mismatch check. No randomness, no remote calls (the cached config is
 *   primed at construction), no transaction id minted here.
 * - **`stableBinding`** opts `rail`/`instrumentId` into the bound set (default binding is only amount/currency/recipient)
 *   so a `balance` credential cannot be redeemed on an `instrument` route, or vice-versa.
 * - **`validate`** delegates the non-mutating acceptance check to `/v1/mpp/validate`.
 * - **`broadcast`** delegates the terminal payment operation to `/v1/mpp/broadcast` and maps the receipt to mppx.
 * - Mppx supplies the compatibility **`verify`** hook as validation followed by broadcast.
 *
 * @param parameters - Auth, environment, and seller defaults ({@link InflowSellerParameters}). Note: the binding
 *   `secretKey` is **not** here — it is supplied to `Mppx.create({ secretKey })` / `MPP_SECRET_KEY`, never the API
 *   key.
 * @returns The `inflow` server method to pass into `Mppx.create({ methods: [...] })`.
 */
function inflowChargeMethod(
  parameters: InflowSellerParameters,
): Method.Server<typeof inflowCharge, { currency?: string }> {
  const client = new MppClient({
    apiKey: parameters.apiKey,
    ...(parameters.environment !== undefined ? { environment: parameters.environment } : {}),
    ...(parameters.baseUrl !== undefined ? { baseUrl: parameters.baseUrl } : {}),
    ...(parameters.timeoutMs !== undefined ? { timeoutMs: parameters.timeoutMs } : {}),
    ...(parameters.fetch !== undefined ? { fetch: parameters.fetch } : {}),
  });
  const config = createConfigClient(client);

  // Prime the config cache at construction (mirrors the x402 seller client). The result is memoised; a rejection here
  // is swallowed so it surfaces at the first charge or lifecycle call rather than as an unhandled
  // rejection at import time.
  void config.load().catch(() => undefined);

  const defaults = buildDefaults(parameters);

  return Method.toServer(inflowCharge, {
    canOffer: parameters.canOffer,
    defaults,

    async request({ request }) {
      const loaded = await config.load();
      return { ...request, recipient: loaded.sellerId, methodDetails: deriveMethodDetails(request, loaded, 'charge') };
    },

    stableBinding(request) {
      const rail = request.methodDetails?.rail ?? 'balance';
      const instrumentId = request.methodDetails?.instrumentId;
      return {
        amount: request.amount,
        currency: request.currency,
        recipient: request.recipient,
        rail,
        ...(instrumentId !== undefined ? { instrumentId } : {}),
      };
    },

    async broadcast({ credential }) {
      return broadcast(credential, client, await config.load());
    },

    async validate({ credential, request }) {
      const details = await validateCredential(credential, client);
      return {
        challenge: credential.challenge,
        credential,
        details,
        intent: inflowCharge.intent,
        method: inflowCharge.name,
        request,
        ...(credential.source !== undefined ? { source: credential.source } : {}),
      };
    },
  });
}

/**
 * The seller-side `inflow` **subscription** method — the recurring sibling of the charge intent (see
 * docs/mpp/extensions.md). `Mppx.create({ methods: [inflow.subscription(...)], secretKey
 * }).compose('inflow/subscription', { amount, currency, periodUnit, periodCount, subscriptionExpires })` mints the
 * subscription `WWW-Authenticate: Payment` challenge locally; validation and broadcast delegate to the InFlow PSP.
 *
 * The request and lifecycle hooks are identical to charge; `stableBinding` additionally binds the recurring terms
 * (`periodUnit`, `periodCount`, `subscriptionExpires`, `externalId`) so a credential cannot be redeemed against altered
 * subscription terms. Subscriptions settle on the balance rail (enforced server-side).
 *
 * @param parameters - Auth, environment, and seller defaults ({@link InflowSellerParameters}).
 * @returns The `inflow` subscription server method to pass into `Mppx.create({ methods: [...] })`.
 */
function inflowSubscriptionMethod(
  parameters: InflowSellerParameters,
): Method.Server<typeof inflowSubscription, { currency?: string }> {
  const client = new MppClient({
    apiKey: parameters.apiKey,
    ...(parameters.environment !== undefined ? { environment: parameters.environment } : {}),
    ...(parameters.baseUrl !== undefined ? { baseUrl: parameters.baseUrl } : {}),
    ...(parameters.timeoutMs !== undefined ? { timeoutMs: parameters.timeoutMs } : {}),
    ...(parameters.fetch !== undefined ? { fetch: parameters.fetch } : {}),
  });
  const config = createConfigClient(client);

  void config.load().catch(() => undefined);

  return Method.toServer(inflowSubscription, {
    defaults: buildDefaults(parameters),

    async request({ request }) {
      const loaded = await config.load();
      return {
        ...request,
        recipient: loaded.sellerId,
        methodDetails: deriveMethodDetails(request, loaded, 'subscription'),
      };
    },

    stableBinding(request) {
      const rail = request.methodDetails?.rail ?? 'balance';
      const instrumentId = request.methodDetails?.instrumentId;
      return {
        amount: request.amount,
        currency: request.currency,
        recipient: request.recipient,
        rail,
        periodUnit: request.periodUnit,
        periodCount: request.periodCount,
        subscriptionExpires: request.subscriptionExpires,
        ...(request.externalId !== undefined ? { externalId: request.externalId } : {}),
        ...(instrumentId !== undefined ? { instrumentId } : {}),
      };
    },

    async broadcast({ credential }) {
      return broadcast(credential, client, await config.load());
    },

    async validate({ credential, request }) {
      const details = await validateCredential(credential, client);
      return {
        challenge: credential.challenge,
        credential,
        details,
        intent: inflowSubscription.intent,
        method: inflowSubscription.name,
        request,
        ...(credential.source !== undefined ? { source: credential.source } : {}),
      };
    },
  });
}

/**
 * The seller-side `inflow` method namespace: `inflow(...)` and `inflow.charge(...)` build the charge method, and
 * `inflow.subscription(...)` builds the recurring method. Register the ones a route needs, e.g. `Mppx.create({ methods:
 * [inflow(p), inflow.subscription(p)], secretKey })`.
 */
export const inflow: typeof inflowChargeMethod & {
  readonly charge: typeof inflowChargeMethod;
  readonly subscription: typeof inflowSubscriptionMethod;
} = Object.assign(inflowChargeMethod, { charge: inflowChargeMethod, subscription: inflowSubscriptionMethod });

/**
 * The seller-side `tempo` method, built as a **native mppx server method** — the Tempo analog of {@link inflow}.
 * `Mppx.create({ methods: [tempo(...)], secretKey }).charge({ amount })` mints and HMAC-binds the `WWW-Authenticate:
 * Payment` challenge **locally** with the seller's `secretKey`; this factory supplies the request enrichment, the
 * binding fields, and PSP-backed validation and broadcast hooks.
 *
 * - **`defaults`** pin the seller's TIP-20 `currency` and Tempo `recipient` so `charge({ amount })` need not repeat them.
 * - **`request`** fills `currency` / `recipient` from defaults and derives the Tempo `methodDetails` (chain id,
 *   fee-payer, supported modes) from the seller parameters merged with any per-charge overrides.
 * - **`stableBinding`** binds the full Tempo charge — amount, currency, recipient, chain id, fee-payer, memo, splits,
 *   supported modes, description, externalId — so a credential cannot be redeemed against altered on-chain terms.
 * - **`validate`** performs the non-mutating PSP check and **`broadcast`** performs the terminal operation.
 *
 * @param parameters - Auth, environment, and Tempo seller defaults ({@link TempoSellerParameters}). The binding
 *   `secretKey` is supplied to `Mppx.create({ secretKey })`, never the API key.
 * @returns The `tempo` server method to pass into `Mppx.create({ methods: [...] })`.
 */
export function tempo(
  parameters: TempoSellerParameters,
): Method.Server<typeof tempoCharge, { currency?: string; recipient?: string }> {
  const client = new MppClient({
    apiKey: parameters.apiKey,
    ...(parameters.environment !== undefined ? { environment: parameters.environment } : {}),
    ...(parameters.baseUrl !== undefined ? { baseUrl: parameters.baseUrl } : {}),
    ...(parameters.timeoutMs !== undefined ? { timeoutMs: parameters.timeoutMs } : {}),
    ...(parameters.fetch !== undefined ? { fetch: parameters.fetch } : {}),
  });
  const config = createConfigClient(client);

  void config.load().catch(() => undefined);

  return Method.toServer(tempoCharge, {
    canOffer: parameters.canOffer,
    defaults: buildTempoDefaults(parameters),

    request({ request }) {
      return {
        ...request,
        currency: request.currency ?? parameters.currency,
        methodDetails: deriveTempoMethodDetails(request, parameters),
        recipient: request.recipient ?? parameters.recipient,
      };
    },

    stableBinding(request) {
      return {
        amount: request.amount,
        chainId: request.methodDetails?.chainId,
        currency: request.currency,
        description: request.description,
        externalId: request.externalId,
        feePayer: request.methodDetails?.feePayer,
        memo: request.methodDetails?.memo,
        recipient: request.recipient,
        splits: request.methodDetails?.splits,
        supportedModes: request.methodDetails?.supportedModes,
      };
    },

    async broadcast({ credential }) {
      return broadcast(credential, client, await config.load());
    },

    async validate({ credential, request }) {
      const details = await validateCredential(credential, client);
      return {
        challenge: credential.challenge,
        credential,
        details,
        intent: tempoCharge.intent,
        method: tempoCharge.name,
        request,
        ...(credential.source !== undefined ? { source: credential.source } : {}),
      };
    },
  });
}

/**
 * Build the mppx request `defaults` from the seller parameters — only the keys the seller actually pinned, so unset
 * fields remain caller-supplied.
 *
 * @param parameters - The seller parameters.
 * @returns A partial request used as mppx `defaults`.
 */
function buildDefaults(parameters: InflowSellerParameters): { currency?: string } {
  return {
    ...(parameters.currency !== undefined ? { currency: parameters.currency } : {}),
  };
}

/**
 * Build the mppx request `defaults` for the `tempo` method: the TIP-20 `currency` and the Tempo `recipient` the seller
 * pinned (both required for a Tempo charge).
 *
 * @param parameters - The Tempo seller parameters.
 * @returns A partial request used as mppx `defaults`.
 */
function buildTempoDefaults(parameters: TempoSellerParameters): { currency: string; recipient: string } {
  return {
    currency: parameters.currency,
    recipient: parameters.recipient,
  };
}

/**
 * Derive the `methodDetails` selector from the PSP's intent and currency capability matrix. Pure function of request +
 * cached config, so mppx's verify-time re-derivation reproduces the same value.
 *
 * @param request - The (defaulted) charge request.
 * @param loaded - The cached config.
 * @returns The resolved rail/instrument selector.
 * @throws {@link MppUnsupportedCurrencyError} When the intent and currency combination is absent.
 */
function deriveMethodDetails(
  request: InflowChargeRequestInput,
  loaded: LoadedConfig,
  intent: 'charge' | 'subscription',
): ResolvedMethodDetails {
  const legacyCapability = loaded.currencyRails[request.currency];
  const hasIntentMatrix = Object.keys(loaded.intentCurrencyRails).length > 0;
  const advertised = hasIntentMatrix
    ? (loaded.intentCurrencyRails[intent]?.[request.currency] ?? [])
    : legacyCapability === undefined
      ? []
      : [legacyCapability];
  if (advertised.length === 0) {
    throw new MppUnsupportedCurrencyError(request.currency);
  }
  const requestedRail = request.methodDetails?.rail;
  if (requestedRail === undefined && advertised.length > 1) {
    throw new MppAmbiguousRailError(request.currency, intent);
  }
  const selected =
    requestedRail === undefined ? advertised.at(0) : advertised.find((capability) => capability.rail === requestedRail);
  if (selected === undefined || (selected.rail !== 'balance' && selected.rail !== 'instrument')) {
    throw new MppUnsupportedRailError(request.currency, intent, requestedRail ?? 'unknown');
  }
  const instrumentId = request.methodDetails?.instrumentId;
  const resolvedRail: 'balance' | 'instrument' = selected.rail === 'balance' ? 'balance' : 'instrument';
  if (resolvedRail === 'instrument' && selected.instrumentId === 'required' && instrumentId === undefined) {
    throw new MppInstrumentRequiredError(request.currency, intent);
  }
  return {
    rail: resolvedRail,
    ...(instrumentId !== undefined ? { instrumentId } : {}),
  };
}

/**
 * Merge the Tempo `methodDetails` for a charge: seller-configured defaults beneath any per-charge overrides, then
 * default `feePayer` to `false` and `supportedModes` to `['pull']` (the only mode the InFlow buyer fulfils).
 *
 * @param request - The charge request.
 * @param parameters - The Tempo seller parameters supplying the defaults.
 * @returns The resolved Tempo method-details selector.
 */
function deriveTempoMethodDetails(
  request: TempoChargeRequestInput,
  parameters: TempoSellerParameters,
): TempoChargeRequestInput['methodDetails'] {
  return {
    ...(parameters.methodDetails ?? {}),
    ...(request.methodDetails ?? {}),
    feePayer: request.methodDetails?.feePayer ?? parameters.methodDetails?.feePayer ?? false,
    supportedModes: request.methodDetails?.supportedModes ?? parameters.methodDetails?.supportedModes ?? ['pull'],
  };
}

/** Ask the PSP whether a credential is currently acceptable without consuming payment state. */
async function validateCredential(
  credential: Credential.Credential<Record<string, unknown>>,
  client: MppClient,
): Promise<Record<string, unknown>> {
  const wireCredential = toWireCredential(credential);
  const result: unknown = await client.validate({ credential: wireCredential });
  if (!isRecord(result)) {
    throw new MppCredentialProblemError(fallbackProblem('validation'));
  }
  if (result['success'] !== true) {
    throw new MppCredentialProblemError(result['problem'] ?? fallbackProblem('validation'));
  }
  const acceptedCredential = result['credential'];
  if (
    result['challenge'] === undefined ||
    encode(result['challenge']) !== encode(wireCredential.challenge) ||
    !isRecord(acceptedCredential) ||
    encode(acceptedCredential) !== encode(wireCredential) ||
    result['intent'] !== wireCredential.challenge.intent ||
    result['method'] !== wireCredential.challenge.method ||
    result['source'] !== wireCredential.source ||
    !isRecord(result['request']) ||
    encode(acceptedCredential['payload']) !== encode(wireCredential.payload) ||
    (result['details'] !== undefined && !isRecord(result['details']))
  ) {
    throw new MppCredentialProblemError(fallbackProblem('validation'));
  }
  return result['details'] ?? {};
}

/** Forward a validated credential to the PSP's authoritative terminal operation. */
async function broadcast(
  credential: Credential.Credential<Record<string, unknown>>,
  client: MppClient,
  loaded: LoadedConfig,
): Promise<Receipt.Receipt> {
  const wireCredential = toWireCredential(credential);
  const body: MppBroadcastRequest = { credential: wireCredential };

  const options: MppRequestOptions = loaded.featureFlags.idempotencyKeyEnabled
    ? { idempotencyKey: randomUUID() }
    : {};
  const result: unknown = await client.broadcast(body, options);
  if (!isRecord(result) || !isMppReceipt(result['receipt'])) {
    const problem = isRecord(result) ? result['problem'] : undefined;
    throw new MppCredentialProblemError(problem ?? fallbackProblem('broadcast'));
  }
  return Receipt.from(toMppxReceipt(result['receipt']));
}

/**
 * Map mppx's verified credential to the InFlow wire {@link MppCredential}. mppx holds `challenge.request` as the parsed
 * object; the server expects the base64url-JCS string, so it is re-encoded with the core codec (byte-for-byte identical
 * to the server's canonicalisation — locked by the shared codec vectors). The server reads the method-specific payload
 * and source from the credential.
 *
 * @param credential - The mppx credential from a lifecycle hook.
 * @returns The InFlow wire credential.
 */
function toWireCredential(credential: Credential.Credential<Record<string, unknown>>): MppCredential {
  const source = credential.challenge;
  const challenge: MppChallenge = {
    id: source.id,
    realm: source.realm,
    method: source.method,
    intent: source.intent,
    request: encode(source.request),
    ...(source.expires !== undefined ? { expires: source.expires } : {}),
    ...(source.description !== undefined ? { description: source.description } : {}),
    ...(source.digest !== undefined ? { digest: source.digest } : {}),
    ...(source.opaque !== undefined ? { opaque: source.opaque } : {}),
  };
  return {
    challenge,
    payload: credential.payload,
    source: credential.source ?? '',
  };
}

/**
 * Map the InFlow {@link MppReceipt} onto mppx's receipt shape while retaining InFlow's method-specific fields.
 *
 * @param receipt - The InFlow receipt.
 * @returns Parameters for `Receipt.from`.
 */
function toMppxReceipt(receipt: MppReceipt): Receipt.from.Parameters {
  const extensionFields = toReceiptExtensions(receipt);

  return {
    ...(receipt.challengeId !== undefined ? { challengeId: receipt.challengeId } : {}),
    ...(receipt.externalId !== undefined ? { externalId: receipt.externalId } : {}),
    method: receipt.method,
    reference: receipt.reference,
    ...(receipt.settlement !== undefined ? { settlement: receipt.settlement } : {}),
    status: receipt.status,
    ...(receipt.subscriptionId !== undefined ? { subscriptionId: receipt.subscriptionId } : {}),
    timestamp: receipt.timestamp,
    ...extensionFields,
  };
}

/**
 * Return method-specific fields from the PSP receipt while filtering non-extension and framework keys.
 *
 * @param receipt - Wire receipt from `/v1/mpp/broadcast`.
 * @returns The retained extension-like top-level fields.
 */
function toReceiptExtensions(receipt: MppReceipt): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const budget = { entries: MAX_RECEIPT_EXTENSION_ENTRIES };
  for (const [key, value] of Object.entries(receipt)) {
    if (RECEIPT_EXTENSION_KEYS.has(key) || UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (value !== undefined) {
      const sanitized = sanitizeSellerReceiptExtensionValue(value, 0, budget);
      if (sanitized !== undefined) {
        const candidate = { ...out, [key]: sanitized };
        if (JSON.stringify(candidate).length <= MAX_RECEIPT_EXTENSIONS_LENGTH) out[key] = sanitized;
      }
    }
  }
  return out;
}

function sanitizeSellerReceiptExtensionValue(value: unknown, depth: number, budget: { entries: number }): unknown {
  return sanitizeJsonValue(value, depth, budget, MAX_RECEIPT_EXTENSION_DEPTH);
}

/**
 * Synthesise a verification-failed problem for a contract-violating lifecycle response.
 *
 * @param operation - Lifecycle operation that returned the malformed response.
 * @returns A minimal RFC 9457 problem.
 */
function fallbackProblem(operation: 'broadcast' | 'validation'): MppProblemDetail {
  return {
    type: PROBLEM_TYPES.VERIFICATION_FAILED,
    title: 'Verification Failed',
    status: 402,
    detail: `The PSP ${operation} response was malformed.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMppReceipt(value: unknown): value is MppReceipt {
  if (!isRecord(value)) return false;
  const settlement = value['settlement'];
  return (
    typeof value['method'] === 'string' &&
    typeof value['reference'] === 'string' &&
    value['status'] === 'success' &&
    typeof value['timestamp'] === 'string' &&
    (settlement === undefined ||
      (isRecord(settlement) && typeof settlement['amount'] === 'string' && typeof settlement['currency'] === 'string'))
  );
}
