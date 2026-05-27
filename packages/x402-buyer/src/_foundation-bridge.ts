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
 * - **Foundation → InFlow is the safe direction** and the implicit assignment compiles without a cast: foundation's
 *   required `extra` is assignable to InFlow's optional one, and `${string}:${string}` is assignable to `string`.
 *   {@link fromFoundationRequirements} is the public conversion any caller can use to thread a decoded `PaymentRequired`
 *   into the InFlow signing surface (`InflowClient.prepareInflowPayment`, `InflowClient.selectInflowRequirement`'s
 *   companion APIs, downstream renderers, etc.) without re-stating the asymmetry.
 * - **InFlow → foundation is the lossy direction.** InFlow's `PaymentRequirements.extra` is optional; the foundation's is
 *   required. InFlow's `PaymentRequirements.network` is the wider `string`; the foundation's is the CAIP-2 template
 *   literal `${string}:${string}`. Going InFlow → foundation requires `as unknown as` because TS can't see that an
 *   absent `extra` is the empty record at runtime, or that an InFlow `network: string` is always CAIP-2 shaped in
 *   practice. Used only inside the SDK for the `createPaymentPayload` write path; not part of the public surface.
 *
 * Per AGENTS.md §Conventions: `as unknown as` lives at documented type boundaries; this module is the documented
 * boundary for the buyer side.
 */

/**
 * Reshape a foundation `PaymentRequirements[]` (the `accepts[]` carried by `PaymentRequired`, as returned by
 * `@x402/core/http`'s `decodePaymentRequiredHeader`) into the InFlow buyer's canonical `@inflowpayai/x402`
 * `PaymentRequirements[]`. The conversion is structural — runtime values are unchanged — and exists because the
 * foundation type narrows `network` to a CAIP-2 template literal and requires `extra`, while InFlow permits the wider
 * `string` form (including non-CAIP-2 identifiers like `'inflow:1'`) and treats `extra` as optional.
 *
 * Use at the boundary where a decoded seller header crosses into InFlow signing or rendering. Once converted, the
 * caller can hand the result to {@link InflowClient.prepareInflowPayment}, list it alongside
 * {@link InflowClient.selectInflowRequirement}'s output without TypeScript flagging the shape mismatch, or feed it into
 * any other code that speaks the InFlow `PaymentRequirements` shape.
 *
 * @param r - The decoded seller `accepts[]` in foundation shape.
 * @returns The same entries, retyped as InFlow `PaymentRequirements[]`. No allocation; the input array is returned
 *   directly.
 */
export function fromFoundationRequirements(
  r: readonly FoundationPaymentRequirements[],
): readonly PaymentRequirements[] {
  return r;
}

/**
 * InFlow `PaymentPayload` → foundation `PaymentPayload`. Lossy direction; safe under V2 wire shape.
 *
 * @internal
 */
export function toFoundationPayload(p: InflowPaymentPayload): FoundationPaymentPayload {
  return p as unknown as FoundationPaymentPayload;
}
