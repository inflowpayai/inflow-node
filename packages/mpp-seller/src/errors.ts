import { PROBLEM_TYPES, type MppProblemDetail } from '@inflowpayai/mpp';
import { sanitizeMppProblemDetail } from '@inflowpayai/mpp-internal';
import { Errors } from 'mppx';

/**
 * Thrown when the PSP rejects validation or broadcast. It extends mppx's {@link Errors.PaymentError} so the framework
 * treats it as a payment failure and renders the RFC 9457 problem body with the correct HTTP status, rather than
 * collapsing it into a generic `VerificationFailedError`. Valid server-returned problem fields are preserved after
 * sanitization; malformed responses become a fixed verification-failed problem instead of retaining untrusted raw
 * data.
 */
export class MppCredentialProblemError extends Errors.PaymentError {
  override readonly name = 'MppCredentialProblemError';
  /** RFC 9457 type URI, taken from the server problem. */
  readonly type: string;
  /** Human-readable summary, taken from the server problem. */
  readonly title: string;
  /** HTTP status, taken from the server problem (always `402` for MPP payment-flow failures). */
  override readonly status: number;
  /** The full server-returned problem detail. */
  readonly problem: MppProblemDetail;

  /** @param problem - The RFC 9457 problem returned by the PSP. */
  constructor(problem: unknown) {
    const sanitized = sanitizeMppProblemDetail(problem) ?? malformedProblem();
    super(sanitized.detail);
    this.problem = sanitized;
    this.type = sanitized.type;
    this.title = sanitized.title;
    this.status = sanitized.status;
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
      ...(this.problem.hint !== undefined ? { hint: this.problem.hint } : {}),
      ...(this.problem.details !== undefined ? { details: this.problem.details } : {}),
      ...(challengeId !== undefined ? { challengeId } : {}),
      ...(this.problem.extensions ?? {}),
    };
  }
}

/** Return a fixed safe problem when a runtime caller supplies a contract-violating problem object. */
function malformedProblem(): MppProblemDetail {
  return {
    type: PROBLEM_TYPES.VERIFICATION_FAILED,
    title: 'Payment Verification Failed',
    status: 402,
    detail: 'The PSP credential lifecycle response carried a malformed problem.',
  };
}

/**
 * Thrown when a request's intent and currency have no advertised settlement rail. The seller SDK never invents a rail,
 * so the `request` hook fails fast with this error rather than emitting a malformed header. When `inflow` is the only
 * method on the route, the charge cannot be satisfied.
 */
export class MppUnsupportedCurrencyError extends Error {
  override readonly name = 'MppUnsupportedCurrencyError';
  /** The unsupported currency. */
  readonly currency: string;

  /** @param currency - The unsupported currency. */
  constructor(currency: string) {
    super(`inflow: currency "${currency}" is not supported for this intent by the PSP`);
    this.currency = currency;
  }
}

/** Thrown when an advertised instrument rail requires an instrument identifier and the request omits it. */
export class MppInstrumentRequiredError extends Error {
  override readonly name = 'MppInstrumentRequiredError';

  constructor(currency: string, intent: string) {
    super(`inflow: methodDetails.instrumentId is required for currency "${currency}" and intent "${intent}"`);
  }
}

/** Thrown when a currency and intent offer multiple rails but the request does not select one. */
export class MppAmbiguousRailError extends Error {
  override readonly name = 'MppAmbiguousRailError';

  constructor(currency: string, intent: string) {
    super(
      `inflow: currency "${currency}" offers multiple rails for intent "${intent}"; methodDetails.rail is required`,
    );
  }
}

/** Thrown when a request selects a rail not advertised for its currency and intent. */
export class MppUnsupportedRailError extends Error {
  override readonly name = 'MppUnsupportedRailError';

  constructor(currency: string, intent: string, rail: string) {
    super(`inflow: rail "${rail}" is not supported for currency "${currency}" and intent "${intent}"`);
  }
}
