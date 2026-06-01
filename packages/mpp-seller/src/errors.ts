import type { MppProblemDetail } from '@inflowpayai/mpp';
import { Errors } from 'mppx';

/**
 * Thrown from the `inflow` method's `verify` hook when `POST /v1/mpp/redeem` returns a failure (a `problem` instead of
 * a `receipt`). It extends mppx's {@link Errors.PaymentError} so the framework treats it as a payment failure and
 * renders the RFC 9457 problem body with the correct HTTP status, rather than collapsing it into a generic
 * `VerificationFailedError`. The server-returned {@link MppProblemDetail} is reflected verbatim — `type`, `title`,
 * `status`, `detail`, and any `extensions` — so callers and buyers see the PSP's exact failure reason.
 */
export class MppRedeemProblemError extends Errors.PaymentError {
  override readonly name = 'MppRedeemProblemError';
  /** RFC 9457 type URI, taken from the server problem. */
  readonly type: string;
  /** Human-readable summary, taken from the server problem. */
  readonly title: string;
  /** HTTP status, taken from the server problem (always `402` for MPP payment-flow failures). */
  override readonly status: number;
  /** The full server-returned problem detail. */
  readonly problem: MppProblemDetail;

  /** @param problem - The RFC 9457 problem the PSP returned on the redeem response. */
  constructor(problem: MppProblemDetail) {
    super(problem.detail);
    this.problem = problem;
    this.type = problem.type;
    this.title = problem.title;
    this.status = problem.status;
  }

  /**
   * Render this failure as RFC 9457 Problem Details, reflecting the PSP's `detail` and any `extensions` and stamping
   * the challenge id when the framework supplies one.
   *
   * @param challengeId - The challenge id the framework associates with the failure, when known.
   * @returns The problem-details object the HTTP transport serialises into the 402 body.
   */
  override toProblemDetails(challengeId?: string): Errors.PaymentError.ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.problem.detail,
      ...(challengeId !== undefined ? { challengeId } : {}),
      ...(this.problem.extensions ?? {}),
    };
  }
}

/**
 * Thrown when a charge's currency is not advertised in the PSP's `currencyRails` map (e.g. `JPY` against a USD/USDC
 * PSP). The seller SDK never invents a rail: an unsupported currency cannot produce an `inflow` challenge, so the
 * `request` hook fails fast with this error rather than emitting a malformed header. When `inflow` is the only method
 * on the route, the charge cannot be satisfied.
 */
export class MppUnsupportedCurrencyError extends Error {
  override readonly name = 'MppUnsupportedCurrencyError';
  /** The unsupported charge currency. */
  readonly currency: string;

  /** @param currency - The charge currency absent from `currencyRails`. */
  constructor(currency: string) {
    super(`inflow: currency "${currency}" is not supported by this PSP (absent from config.currencyRails)`);
    this.currency = currency;
  }
}
