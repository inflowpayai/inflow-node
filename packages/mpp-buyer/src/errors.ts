import type { MppProblemDetail } from '@inflowpayai/mpp';

/**
 * Thrown when an in-flight MPP transaction is abandoned by the caller — either via the method's `cleanup()` or by
 * aborting the `AbortSignal` passed to a fulfilment. The buyer exits the polling loop immediately and fires a
 * fire-and-forget cancel of the backing approval; this error is what the awaiting `createCredential` rejects with.
 */
export class MppPaymentCancelledError extends Error {
  /** The backing approval id, when the server surfaced one on the pending response. */
  readonly approvalId?: string;

  /** @param approvalId - Backing approval id, when known. */
  constructor(approvalId?: string) {
    super(
      approvalId === undefined ? 'MPP payment cancelled by caller' : `MPP approval ${approvalId} cancelled by caller`,
    );
    this.name = 'MppPaymentCancelledError';
    if (approvalId !== undefined) this.approvalId = approvalId;
  }
}

/**
 * Thrown when the server reports `state: 'failed'` for the transaction. Carries the RFC 9457 {@link MppProblemDetail}
 * the server returned so callers can branch on `problem.type` without the SDK enumerating every server-side failure.
 */
export class MppPaymentFailedError extends Error {
  /** The problem detail the server returned with the failed state, when present. */
  readonly problem?: MppProblemDetail;

  /** @param problem - The server-returned RFC 9457 problem detail, when present. */
  constructor(problem?: MppProblemDetail) {
    super(problem?.detail ?? problem?.title ?? 'MPP payment failed');
    this.name = 'MppPaymentFailedError';
    if (problem !== undefined) this.problem = problem;
  }
}

/**
 * Thrown when the server reports `state: 'expired'` — the challenge/approval window elapsed before the transaction
 * reached `ready`. Server-side expiry is the orphan backstop, so a buyer that polls past the window sees this.
 */
export class MppPaymentExpiredError extends Error {
  /** The transaction id, when the server surfaced one. */
  readonly transactionId?: string;

  /** @param transactionId - The expired transaction's id, when known. */
  constructor(transactionId?: string) {
    super(transactionId === undefined ? 'MPP transaction expired' : `MPP transaction ${transactionId} expired`);
    this.name = 'MppPaymentExpiredError';
    if (transactionId !== undefined) this.transactionId = transactionId;
  }
}

/**
 * Thrown when wall-clock exceeds the fulfilment budget (`timeoutMs`) before the transaction reaches `ready`. The budget
 * defaults to 15 minutes, matching the server-side approval expiry.
 */
export class MppPaymentTimeoutError extends Error {
  /** The transaction id the timeout applied to, when known. */
  readonly transactionId?: string;
  /** Effective budget in milliseconds that elapsed. */
  readonly timeoutMs: number;

  /**
   * @param timeoutMs - The configured budget that elapsed.
   * @param transactionId - The pending transaction's id, when known.
   */
  constructor(timeoutMs: number, transactionId?: string) {
    super(
      transactionId === undefined
        ? `MPP transaction not ready within ${String(timeoutMs)}ms`
        : `MPP transaction ${transactionId} not ready within ${String(timeoutMs)}ms`,
    );
    this.name = 'MppPaymentTimeoutError';
    this.timeoutMs = timeoutMs;
    if (transactionId !== undefined) this.transactionId = transactionId;
  }
}

/**
 * Thrown when a `ready` transaction carries no credential, or the server-produced credential cannot be decoded from its
 * base64url form. Raised loudly at the boundary rather than producing a malformed `Authorization: Payment` header.
 */
export class MppMalformedCredentialError extends Error {
  /**
   * @param detail - What specifically was wrong (missing credential, decode failure).
   * @param cause - The underlying error, when wrapping one.
   */
  constructor(detail: string, cause?: unknown) {
    super(`MPP credential malformed — ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'MppMalformedCredentialError';
  }
}
