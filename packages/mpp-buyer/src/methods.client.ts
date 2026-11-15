import * as Methods from '@inflowpayai/mpp';
import { z } from '@inflowpayai/mpp';
import { Credential, Method } from 'mppx';
import { accepts, cardControls, inflowControls, tempoControls } from './controls.js';

import { MppMalformedCredentialError } from './errors.js';
import { createFulfiller, toWireChallenge } from './fulfilment.js';
import type {
  CardBuyerParameters,
  FulfilChallenge,
  InflowBuyerParameters,
  InflowChargeBuyerParameters,
  TempoBuyerParameters,
} from './types.js';

const cancellationContext = { signal: z.optional(z.instanceof(AbortSignal)) };

export const cardContextSchema = z.extend(Methods.cardPaymentOptionsSchema, cancellationContext);

/** Uses a linked Visa card and its VIC allowance; the server issues the encrypted purchase credential. */
export function card(parameters: CardBuyerParameters) {
  const check = cardControls(parameters);
  const { maxAmount: _maxAmount, maxAtomicAmount: _maxAtomicAmount, ...clientParameters } = parameters;
  const fulfiller = createFulfiller(clientParameters);
  const method = Method.toClient(Methods.cardCharge, {
    context: cardContextSchema,
    canHandleChallenge: ({ challenge }) =>
      accepts(() => check(Methods.cardChargeRequestSchema.parse(challenge.request))),
    async createCredential({ challenge, context }) {
      const { signal, ...options } = cardContextSchema.parse(context);
      check(Methods.cardChargeRequestSchema.parse(challenge.request));
      // mppx permits explicit undefined on optional fields; the wire encoder omits those fields.
      const parsed = challenge as FulfilChallenge;
      const expectedChallenge = Methods.encode(toWireChallenge(parsed));
      const credential = await fulfiller.fulfil(parsed, options, signal === undefined ? undefined : { signal });
      if (Methods.encode(credential.challenge) !== expectedChallenge) {
        throw new MppMalformedCredentialError('CARD credential does not match the requested challenge');
      }
      if (!Methods.cardCredentialPayloadSchema.safeParse(credential.payload).success) {
        throw new MppMalformedCredentialError('invalid CARD credential payload');
      }
      return `Payment ${Methods.encodeCredential(credential)}`;
    },
  });
  return Object.assign(method, {
    cleanup(): void {
      fulfiller.cleanup();
    },
    cancelApproval(approvalId: string): Promise<void> {
      return fulfiller.cancelApproval(approvalId);
    },
  });
}

/**
 * Per-call payment options for the `inflow` method, validated by `mppx` before `createCredential` runs. Mirrors the
 * core `InflowPaymentOptions`: the rail is derived from the seller's challenge (the buyer does not choose it), so the
 * only buyer-supplied selector is `instrumentId` for instrument-rail challenges. There is no `blockchain` field.
 */
export const inflowContextSchema = z.object({
  ...cancellationContext,
  instrumentId: z.optional(z.guid()),
});

export const inflowSubscriptionContextSchema = z.object({
  ...cancellationContext,
  subscriptionId: z.optional(z.guid()),
});

/**
 * Per-call payment options for the `tempo` method. The Tempo charge carries no buyer-supplied selectors — the asset,
 * chain, and recipient are fixed by the seller's challenge and the on-chain credential is produced server-side — so the
 * context contains only the optional local cancellation signal.
 */
export const tempoContextSchema = z.object(cancellationContext);

/**
 * The buyer-side `inflow` client method. Attaches `Method.toClient` behaviour to the shared `inflow` definition from
 * `@inflowpayai/mpp`: `createCredential` does **not** sign locally — it drives `POST /v1/transactions/mpp` → poll `GET
 * /v1/transactions/{id}/mpp` through the pending → ready lifecycle and returns the server-produced credential,
 * re-serialized for the `Authorization: Payment` wire value with `source` and `payload` forwarded verbatim.
 *
 * Pass the result to `Mppx.create({ methods: [inflow({ apiKey })] })`. The returned method also carries `cleanup()`
 * (aborts any in-flight poll) and `cancelApproval(approvalId)` (fire-and-forget cancel of a backing approval, e.g. for
 * out-of-process resumption).
 *
 * @param parameters - Auth, environment, and polling knobs ({@link InflowBuyerParameters}).
 * @returns The `inflow` client method augmented with `cleanup` / `cancelApproval`.
 */
function inflowChargeClient(parameters: InflowChargeBuyerParameters) {
  const check = inflowControls(parameters);
  const {
    currencies: _currencies,
    maxAmount: _maxAmount,
    expectedRecipients: _expectedRecipients,
    ...clientParameters
  } = parameters;
  const fulfiller = createFulfiller(clientParameters);

  const method = Method.toClient(Methods.charge, {
    context: inflowContextSchema,
    canHandleChallenge: ({ challenge }) =>
      accepts(() => check(Methods.inflowChargeRequestSchema.parse(challenge.request))),
    async createCredential({ challenge, context = {} }) {
      check(challenge.request);
      const { signal, ...options } = context;
      const credential = await fulfiller.fulfil(
        challenge as FulfilChallenge,
        options,
        signal === undefined ? undefined : { signal },
      );
      // Re-serialize for the wire. mppx re-encodes `challenge.request` from the parsed object; `payload` (carrying the
      // server-stamped `transactionId`) and `source` are forwarded exactly as the server produced them.
      return Credential.serialize({
        challenge,
        payload: credential.payload,
        source: credential.source,
      });
    },
  });

  return Object.assign(method, {
    /** Abort any in-flight fulfilment poll held by this method instance. */
    cleanup(): void {
      fulfiller.cleanup();
    },
    /**
     * Fire-and-forget cancel of a backing approval via `POST /v1/approvals/{approvalId}/cancel`. Resolves on any
     * server-side outcome (cancelled, already-terminal, not found); useful for out-of-process resumption.
     */
    cancelApproval(approvalId: string): Promise<void> {
      return fulfiller.cancelApproval(approvalId);
    },
  });
}

/**
 * The buyer-side `inflow` **subscription** client method — the recurring sibling of the charge intent (see
 * docs/mpp/extensions.md). `createCredential` reuses the exact `POST /v1/transactions/mpp` → poll → credential
 * lifecycle as charge when no subscription identifier is supplied. With `context.subscriptionId`, it requests a fresh,
 * short-lived credential bound to the seller's current challenge and the existing subscription.
 *
 * @param parameters - Auth, environment, and polling knobs ({@link InflowBuyerParameters}).
 * @returns The `inflow` subscription client method augmented with `cleanup` / `cancelApproval`.
 */
function inflowSubscriptionClient(parameters: InflowBuyerParameters) {
  const fulfiller = createFulfiller(parameters);

  const method = Method.toClient(Methods.subscription, {
    context: inflowSubscriptionContextSchema,
    async createCredential({ challenge, context = {} }) {
      const parsed = challenge as FulfilChallenge;
      const callOptions = context.signal === undefined ? undefined : { signal: context.signal };
      const credential =
        context.subscriptionId === undefined
          ? await fulfiller.fulfil(parsed, {}, callOptions)
          : await fulfiller.authorizeSubscription(context.subscriptionId, parsed, callOptions);
      return Credential.serialize({
        challenge,
        payload: credential.payload,
        source: credential.source,
      });
    },
  });

  return Object.assign(method, {
    /** Abort any in-flight fulfilment poll held by this method instance. */
    cleanup(): void {
      fulfiller.cleanup();
    },
    /** Fire-and-forget cancel of a backing approval via `POST /v1/approvals/{approvalId}/cancel`. */
    cancelApproval(approvalId: string): Promise<void> {
      return fulfiller.cancelApproval(approvalId);
    },
  });
}

/**
 * The buyer-side `inflow` method namespace: `inflow(...)` and `inflow.charge(...)` build the charge client method, and
 * `inflow.subscription(...)` builds the recurring one. Register the one(s) a client needs in `Mppx.create({ methods:
 * [...] })`.
 */
export const inflow = Object.assign(inflowChargeClient, {
  charge: inflowChargeClient,
  subscription: inflowSubscriptionClient,
});

/**
 * The buyer-side `tempo` client method. Attaches `Method.toClient` behaviour to the shared `tempo` definition from
 * `@inflowpayai/mpp`. Like `inflow`, `createCredential` does **not** sign locally — it drives `POST
 * /v1/transactions/mpp` → poll `GET /v1/transactions/{id}/mpp` through the pending → ready lifecycle and returns the
 * server-produced credential (for Tempo, the InFlow PSP mints the signed on-chain transfer), re-serialized for the
 * `Authorization: Payment` wire value with `source` and `payload` forwarded verbatim.
 *
 * Pass the result to `Mppx.create({ methods: [tempo({ apiKey })] })`. The returned method also carries `cleanup()`
 * (aborts any in-flight poll) and `cancelApproval(approvalId)` (fire-and-forget cancel of a backing approval, e.g. for
 * out-of-process resumption).
 *
 * @param parameters - Auth, environment, and polling knobs ({@link InflowBuyerParameters}).
 * @returns The `tempo` client method augmented with `cleanup` / `cancelApproval`.
 */
export function tempo(parameters: TempoBuyerParameters) {
  const check = tempoControls(parameters);
  const {
    currencies: _currencies,
    decimals: _decimals,
    maxAmount: _maxAmount,
    maxAtomicAmount: _maxAtomicAmount,
    allowedChainIds: _allowedChainIds,
    expectedRecipients: _expectedRecipients,
    ...clientParameters
  } = parameters;
  const fulfiller = createFulfiller(clientParameters);

  const method = Method.toClient(Methods.tempoCharge, {
    context: tempoContextSchema,
    canHandleChallenge: ({ challenge }) =>
      accepts(() => check(Methods.tempoChargeRequestSchema.parse(challenge.request))),
    async createCredential({ challenge, context = {} }) {
      check(challenge.request);
      const { signal, ...options } = context;
      const credential = await fulfiller.fulfil(
        challenge as FulfilChallenge,
        options,
        signal === undefined ? undefined : { signal },
      );
      // Re-serialize for the wire. `payload` (carrying the server-stamped `transactionId`) and `source` are forwarded
      // exactly as the server produced them.
      return Credential.serialize({
        challenge,
        payload: credential.payload,
        source: credential.source,
      });
    },
  });

  return Object.assign(method, {
    /** Abort any in-flight fulfilment poll held by this method instance. */
    cleanup(): void {
      fulfiller.cleanup();
    },
    /**
     * Fire-and-forget cancel of a backing approval via `POST /v1/approvals/{approvalId}/cancel`. Resolves on any
     * server-side outcome (cancelled, already-terminal, not found); useful for out-of-process resumption.
     */
    cancelApproval(approvalId: string): Promise<void> {
      return fulfiller.cancelApproval(approvalId);
    },
  });
}
