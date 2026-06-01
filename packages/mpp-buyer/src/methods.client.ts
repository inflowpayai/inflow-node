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
        ...(credential.source !== undefined ? { source: credential.source } : {}),
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
