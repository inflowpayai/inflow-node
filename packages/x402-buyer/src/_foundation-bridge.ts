import type {
  PaymentPayload as FoundationPaymentPayload,
  PaymentRequirements as FoundationPaymentRequirements,
} from '@x402/core/types';
import type { InflowPaymentPayload, PaymentRequirements } from '@inflowpayai/x402';

/**
 * Single, documented type boundary between InFlow's widened wire types and the foundation's narrower ones. Concentrated
 * here so additions to the foundation shape upstream surface in one place rather than at scattered cast sites.
 *
 * Type asymmetry (runtime-equivalent in both directions; the casts encode that):
 *
 * - **InFlow → foundation is the lossy direction.** InFlow's `PaymentRequirements.extra` is optional; the foundation's is
 *   required. InFlow's `PaymentRequirements.network` is the wider `string`; the foundation's is the CAIP-2 template
 *   literal `${string}:${string}`. Going InFlow → foundation requires `as unknown as` because TS can't see that an
 *   absent `extra` is the empty record at runtime, or that an InFlow `network: string` is always CAIP-2 shaped in
 *   practice.
 * - **Foundation → InFlow is the safe direction** and the implicit assignment compiles without a cast: foundation's
 *   required `extra` is assignable to InFlow's optional one, and `${string}:${string}` is assignable to `string`.
 *   `fromFoundationRequirements` exists only so the call site at `inflow-client.ts:createPaymentPayload` reads
 *   symmetrically against the InFlow → foundation direction.
 *
 * Per AGENTS.md §Conventions: `as unknown as` lives at documented type boundaries; this module is the documented
 * boundary for the buyer side.
 *
 * @internal
 */

/** Foundation `PaymentRequirements[]` → InFlow `readonly PaymentRequirements[]`. Safe direction; no cast needed. */
export function fromFoundationRequirements(
  r: readonly FoundationPaymentRequirements[],
): readonly PaymentRequirements[] {
  return r;
}

/** InFlow `PaymentPayload` → foundation `PaymentPayload`. Lossy direction; safe under V2 wire shape. */
export function toFoundationPayload(p: InflowPaymentPayload): FoundationPaymentPayload {
  return p as unknown as FoundationPaymentPayload;
}
