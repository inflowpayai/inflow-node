import * as Methods from '@inflowpayai/mpp';
import { z } from '@inflowpayai/mpp';
import { Credential, Method } from 'mppx';

import { createFulfiller } from './fulfilment.js';
import type { FulfilChallenge, InflowBuyerParameters } from './types.js';

/**
 * Per-call payment options for the `inflow` method, validated by `mppx` before `createCredential` runs. Mirrors the
 * core `InflowPaymentOptions`: the rail is derived from the seller's challenge (the buyer does not choose it), so the
 * only buyer-supplied selector is `instrumentId` for instrument-rail challenges. There is no `blockchain` field.
 */
export const inflowContextSchema = z.object({
  instrumentId: z.optional(z.guid()),
});

/**
 * Per-call payment options for the `tempo` method. The Tempo charge carries no buyer-supplied selectors — the asset,
 * chain, and recipient are fixed by the seller's challenge and the on-chain credential is produced server-side — so the
 * context is an empty object.
 */
export const tempoContextSchema = z.object({});

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
export function inflow(parameters: InflowBuyerParameters) {
  const fulfiller = createFulfiller(parameters);

  const method = Method.toClient(Methods.charge, {
    context: inflowContextSchema,
    async createCredential({ challenge, context }) {
      // `context` is the validated per-call options (`{ instrumentId? }`), forwarded as the InFlow payment options.
      const options: Record<string, unknown> = { ...context };
      const credential = await fulfiller.fulfil(challenge as FulfilChallenge, options);
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
export function tempo(parameters: InflowBuyerParameters) {
  const fulfiller = createFulfiller(parameters);

  const method = Method.toClient(Methods.tempoCharge, {
    context: tempoContextSchema,
    async createCredential({ challenge, context }) {
      // Tempo takes no per-call options today; spread the (empty) validated context for forward compatibility.
      const options: Record<string, unknown> = { ...context };
      const credential = await fulfiller.fulfil(challenge as FulfilChallenge, options);
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
