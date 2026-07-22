import {
  charge as inflowCharge,
  CREDENTIAL_TRANSACTION_ID,
  encode,
  MppClient,
  PROBLEM_TYPES,
  tempoCharge,
} from '@inflowpayai/mpp';
import type {
  InflowChargeRequestInput,
  MppChallenge,
  MppCredential,
  MppProblemDetail,
  MppReceipt,
  MppRedeemRequest,
  MppRequestOptions,
  TempoChargeRequestInput,
} from '@inflowpayai/mpp';
import { Method, Receipt } from 'mppx';
import type { Credential } from 'mppx';

import { createConfigClient } from './config-client.js';
import { MppRedeemProblemError, MppUnsupportedCurrencyError } from './errors.js';
import type { InflowSellerParameters, LoadedConfig, TempoSellerParameters } from './types.js';

/** The resolved `methodDetails` selector the request hook attaches: rail (derived from currency) + optional instrument. */
interface ResolvedMethodDetails {
  rail: 'balance' | 'instrument';
  instrumentId?: string;
}

/**
 * The seller-side `inflow` method, built as a **native mppx server method**. `Mppx.create({ methods: [inflow(...)],
 * secretKey }).charge({ amount })` mints and HMAC-binds the `WWW-Authenticate: Payment` challenge **locally** with the
 * seller's `secretKey`; this factory only supplies the deterministic request enrichment, the binding fields, and a
 * `verify` that **delegates settlement to the InFlow PSP** via `POST /v1/mpp/redeem`.
 *
 * The flow is the exact analog of `@inflowpayai/x402-seller` delegating verify/settle to the InFlow facilitator while
 * the foundation SDK owns the wire mechanics:
 *
 * - **`defaults`** pin the seller's `currency` so `charge({ amount })` need not repeat it.
 * - **`request`** is a _pure_ function of the request + cached `/config`: it sets the `recipient` to the authenticated
 *   seller (the config's `sellerId`) and derives the rail from the charge currency (`currencyRails`: crypto →
 *   `balance`, fiat → `instrument`), failing fast for an unsupported currency. Purity is required — mppx re-derives the
 *   request at verify, and a non-deterministic hook would trip the binding mismatch check. No randomness, no remote
 *   calls (the cached config is primed at construction), no transaction id minted here.
 * - **`stableBinding`** opts `rail`/`instrumentId` into the bound set (default binding is only amount/currency/recipient)
 *   so a `balance` credential cannot be redeemed on an `instrument` route, or vice-versa.
 * - **`verify`** forwards the submitted credential to `/v1/mpp/redeem` and reflects the result: a receipt becomes an mppx
 *   {@link Receipt} (and the `Payment-Receipt` header); a problem is thrown as an {@link MppRedeemProblemError} (an mppx
 *   `PaymentError`) so the framework emits 402 + the RFC 9457 body. mppx has already verified challenge provenance
 *   (`Challenge.verify`) and route binding (`getChallengeBindingMismatch`) before `verify` runs, so this hook does
 *   **not** re-bind locally.
 *
 * @param parameters - Auth, environment, and seller defaults ({@link InflowSellerParameters}). Note: the binding
 *   `secretKey` is **not** here — it is supplied to `Mppx.create({ secretKey })` / `MPP_SECRET_KEY`, never the API
 *   key.
 * @returns The `inflow` server method to pass into `Mppx.create({ methods: [...] })`.
 */
export function inflow(parameters: InflowSellerParameters): Method.Server<typeof inflowCharge, { currency?: string }> {
  const client = new MppClient({
    apiKey: parameters.apiKey,
    ...(parameters.environment !== undefined ? { environment: parameters.environment } : {}),
    ...(parameters.baseUrl !== undefined ? { baseUrl: parameters.baseUrl } : {}),
    ...(parameters.timeoutMs !== undefined ? { timeoutMs: parameters.timeoutMs } : {}),
    ...(parameters.fetch !== undefined ? { fetch: parameters.fetch } : {}),
  });
  const config = createConfigClient(client);

  // Prime the config cache at construction (mirrors the x402 seller client). The result is memoised; a rejection here
  // is swallowed so it surfaces at the first charge/verify (with the real call stack) rather than as an unhandled
  // rejection at import time.
  void config.load().catch(() => undefined);

  const defaults = buildDefaults(parameters);

  return Method.toServer(inflowCharge, {
    defaults,

    async request({ request }) {
      const loaded = await config.load();
      return { ...request, recipient: loaded.sellerId, methodDetails: deriveMethodDetails(request, loaded) };
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

    async verify({ credential }) {
      return redeem(credential, client, await config.load());
    },
  });
}

/**
 * The seller-side `tempo` method, built as a **native mppx server method** — the Tempo analog of {@link inflow}.
 * `Mppx.create({ methods: [tempo(...)], secretKey }).charge({ amount })` mints and HMAC-binds the `WWW-Authenticate:
 * Payment` challenge **locally** with the seller's `secretKey`; this factory supplies the request enrichment, the
 * binding fields, and a `verify` that **delegates settlement to the InFlow PSP** via `POST /v1/mpp/redeem`.
 *
 * - **`defaults`** pin the seller's TIP-20 `currency` and Tempo `recipient` so `charge({ amount })` need not repeat them.
 * - **`request`** fills `currency` / `recipient` from defaults and derives the Tempo `methodDetails` (chain id,
 *   fee-payer, supported modes) from the seller parameters merged with any per-charge overrides.
 * - **`stableBinding`** binds the full Tempo charge — amount, currency, recipient, chain id, fee-payer, memo, splits,
 *   supported modes, description, externalId — so a credential cannot be redeemed against altered on-chain terms.
 * - **`verify`** forwards the submitted credential to `/v1/mpp/redeem` and reflects the result, exactly as {@link inflow}
 *   does.
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

    async verify({ credential }) {
      return redeem(credential, client, await config.load());
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
 * Derive the `methodDetails` selector for a charge: look the charge currency up in the PSP's `currencyRails` and pin
 * the advertised rail (carrying `instrumentId` when the seller supplied one). Pure function of request + cached config,
 * so mppx's verify-time re-derivation reproduces the same value.
 *
 * @param request - The (defaulted) charge request.
 * @param loaded - The cached config.
 * @returns The resolved rail/instrument selector.
 * @throws {@link MppUnsupportedCurrencyError} When the currency is absent from `currencyRails` (or maps to a rail this
 *   SDK does not serve) — the SDK never invents a rail.
 */
function deriveMethodDetails(request: InflowChargeRequestInput, loaded: LoadedConfig): ResolvedMethodDetails {
  // `currency` is a required, schema-validated string by the time the hook runs (mppx validates the request first).
  const rail = loaded.currencyRails[request.currency]?.rail;
  // `inflow` serves exactly two off-chain rails; a currency mapped to no (or any other) rail is not serviceable.
  if (rail !== 'balance' && rail !== 'instrument') {
    throw new MppUnsupportedCurrencyError(request.currency);
  }
  const instrumentId = request.methodDetails?.instrumentId;
  // `rail` is the open `MppRailLabel`; after the guard it is exactly one of the two literals. Re-state it as the narrow
  // union (no cast) so the resolved selector is strictly typed.
  const resolvedRail: 'balance' | 'instrument' = rail === 'balance' ? 'balance' : 'instrument';
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

/**
 * Forward the submitted credential to `POST /v1/mpp/redeem` and reflect the result. The server owns method-specific
 * replay protection and settlement.
 *
 * @param credential - The verified credential mppx parsed from the `Authorization: Payment` header.
 * @param client - The shared MPP REST client.
 * @param loaded - The cached config (gates the `Idempotency-Key` header on redeem).
 * @returns The mppx {@link Receipt} on success.
 * @throws {@link MppRedeemProblemError} On a redeem failure (problem instead of receipt).
 */
async function redeem(
  credential: Credential.Credential<Record<string, unknown>>,
  client: MppClient,
  loaded: LoadedConfig,
): Promise<Receipt.Receipt> {
  const wireCredential = toWireCredential(credential);
  const body: MppRedeemRequest = { credential: wireCredential };

  const options: MppRequestOptions = {};
  const transactionId = wireCredential.payload[CREDENTIAL_TRANSACTION_ID];
  if (loaded.featureFlags.idempotencyKeyEnabled && typeof transactionId === 'string') {
    // The redeem slot is single-use and keyed on `transactionId`, so it is the natural idempotency key.
    options.idempotencyKey = transactionId;
  }

  const result = await client.redeem(body, options);
  if (result.receipt === undefined) {
    throw new MppRedeemProblemError(result.problem ?? fallbackProblem());
  }
  return Receipt.from(toMppxReceipt(result.receipt));
}

/**
 * Map mppx's verified credential to the InFlow wire {@link MppCredential} for redeem. mppx holds `challenge.request` as
 * the parsed object; the server expects the base64url-JCS string, so it is re-encoded with the core codec
 * (byte-for-byte identical to the server's canonicalisation — locked by the shared codec vectors). The server reads the
 * method-specific payload and source from the credential.
 *
 * @param credential - The mppx credential from `verify`.
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
  return {
    ...(receipt.challengeId !== undefined ? { challengeId: receipt.challengeId } : {}),
    method: receipt.method,
    reference: receipt.reference,
    ...(receipt.settlement !== undefined ? { settlement: receipt.settlement } : {}),
    status: receipt.status,
    timestamp: receipt.timestamp,
  };
}

/**
 * Synthesise a verification-failed problem for the (contract-violating) case where redeem returns neither a receipt nor
 * a problem, so `verify` still throws a typed payment error rather than returning a malformed receipt.
 *
 * @returns A minimal RFC 9457 problem.
 */
function fallbackProblem(): MppProblemDetail {
  return {
    type: PROBLEM_TYPES.VERIFICATION_FAILED,
    title: 'Verification Failed',
    status: 402,
    detail: 'The PSP redeem response carried neither a receipt nor a problem.',
  };
}
