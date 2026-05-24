import type { TransactionStatus } from './types.js';

/**
 * Thrown by `awaitPayload` when the server moves the approval out of `'INITIATED'` without producing an
 * `encodedPayload` — the server has decided not to sign (insufficient funds, user-rejected, internal error, etc.). The
 * terminal `status` string is surfaced verbatim so callers can branch on it without the SDK having to enumerate every
 * server-side failure state.
 */
export class X402ApprovalFailedError extends Error {
  /** The approval id the server returned from `POST /v1/transactions/x402`. */
  readonly approvalId: string;
  /** Terminal status reported by the server. */
  readonly status: TransactionStatus;

  /**
   * @param approvalId - Server-issued approval id.
   * @param status - Terminal status string from the polling response.
   */
  constructor(approvalId: string, status: TransactionStatus) {
    super(`Approval ${approvalId} terminated as ${status} with no payload`);
    this.name = 'X402ApprovalFailedError';
    this.approvalId = approvalId;
    this.status = status;
  }
}

/**
 * Thrown by `awaitPayload` when `cancel()` is called on the same `PreparedPayment`. The cancel is fire-and-forget
 * against the server; the SDK exits the polling loop immediately and never returns the partially-fetched state to the
 * caller.
 */
export class X402ApprovalCancelledError extends Error {
  /** The approval id the server returned from `POST /v1/transactions/x402`. */
  readonly approvalId: string;

  constructor(approvalId: string) {
    super(`Approval ${approvalId} cancelled by caller`);
    this.name = 'X402ApprovalCancelledError';
    this.approvalId = approvalId;
  }
}

/**
 * Thrown by `awaitPayload` when wall-clock exceeds `timeoutMs` or the caller's `signal` aborts before the server has
 * signed.
 */
export class X402ApprovalTimeoutError extends Error {
  /** The approval id the server returned from `POST /v1/transactions/x402`. */
  readonly approvalId: string;
  /** Effective timeout in milliseconds. */
  readonly timeoutMs: number;

  /**
   * @param approvalId - Server-issued approval id.
   * @param timeoutMs - The configured timeout that elapsed.
   */
  constructor(approvalId: string, timeoutMs: number) {
    super(`Approval ${approvalId} not signed within ${String(timeoutMs)}ms`);
    this.name = 'X402ApprovalTimeoutError';
    this.approvalId = approvalId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown by `prepare()` / `sign()` when `SignOptions.paymentId` does not satisfy the `payment-identifier` extension's
 * format rules (16–128 chars, `^[a-zA-Z0-9_-]+$`). Surfaced client-side before any server round trip.
 */
export class X402PaymentIdFormatError extends Error {
  /** The offending input. */
  readonly input: string;

  /** @param input - The {@link SignOptions.paymentId} value that failed validation. */
  constructor(input: string) {
    // JSON.stringify wraps in double quotes and escapes embedded quotes / backslashes / control chars, so an input
    // like `foo"bar` produces an unambiguous, copy-pasteable message instead of `Invalid paymentId "foo"bar";...`.
    super(`Invalid paymentId ${JSON.stringify(input)}; must be 16-128 chars matching ^[a-zA-Z0-9_-]+$`);
    this.name = 'X402PaymentIdFormatError';
    this.input = input;
  }
}

/**
 * Thrown by {@link InflowClient.prepareInflowPayment} when the caller asks the two-phase flow for a requirement the
 * InFlow signer cannot sign. The two-phase flow only exists for InFlow-signed requirements; foundation-signed schemes
 * have no equivalent.
 */
export class X402AdapterRoutingError extends Error {
  /** Scheme of the requirement the adapter could not route. */
  readonly scheme: string;
  /** Network of the requirement the adapter could not route. */
  readonly network: string;

  /**
   * @param scheme - Scheme of the offending requirement.
   * @param network - Network of the offending requirement.
   */
  constructor(scheme: string, network: string) {
    super(
      `InflowClient cannot route requirement (scheme: "${scheme}", network: "${network}"): ` +
        `not in the InFlow buyer capability cache and no two-phase flow exists for foundation-signed schemes`,
    );
    this.name = 'X402AdapterRoutingError';
    this.scheme = scheme;
    this.network = network;
  }
}

/**
 * Thrown by `parseEvmPrivateKey` when the input cannot be normalized to a 32-byte secp256k1 secret. The accepted input
 * forms are `0x`-prefixed hex, bare hex, and InFlow's Java `Hex.encodeHexString(BigInteger.toByteArray())` seed
 * (including the 33-byte sign-byte and sub-32-byte leading-zero-stripped shapes).
 *
 * The raw input is intentionally **not** preserved on the error: a decoding failure can be the user pasting a real key
 * in the wrong encoding (e.g. a Solana base58 secret into the EVM decoder), so the offending value is treated as
 * potential cryptographic material. Use {@link X402InvalidEvmKeyError.reason} for diagnostics; never log the input.
 */
export class X402InvalidEvmKeyError extends Error {
  /** Why the input failed validation. Never contains key bytes. */
  readonly reason: string;

  /**
   * @param reason - Short explanation appended to the error message. Must not contain the raw input — produce a length
   *   / shape description instead (e.g. `'expected 32 bytes, got 31'`).
   */
  constructor(reason: string) {
    super(`Invalid EVM private key: ${reason}`);
    this.name = 'X402InvalidEvmKeyError';
    this.reason = reason;
  }
}

/**
 * Thrown by `decodeSolanaSecret` when the input cannot be decoded to a 64-byte Ed25519 secret key. Accepted input forms
 * are a base58 string (matches InFlow's `SolanaClient.Account.getSeed()` and Phantom's export) or a JSON byte array
 * (matches `solana-keygen`'s output file).
 *
 * The raw input is intentionally **not** preserved on the error: a decoding failure can be the user pasting a real key
 * in the wrong encoding (e.g. a base58 secret with one character mistyped), so the offending value is treated as
 * potential cryptographic material. Use {@link X402InvalidSolanaKeyError.reason} for diagnostics; never log the input.
 */
export class X402InvalidSolanaKeyError extends Error {
  /** Why the input failed validation. Never contains key bytes. */
  readonly reason: string;

  /**
   * @param reason - Short explanation appended to the error message. Must not contain the raw input — produce a length
   *   / shape description instead (e.g. `'expected 64 bytes, got 32'`).
   */
  constructor(reason: string) {
    super(
      `Invalid Solana private key: ${reason}. ` +
        'Expected a 64-byte Ed25519 secret key, supplied either as a base58 string ' +
        '(matches InFlow SolanaClient.Account.getSeed()) or a JSON byte array ' +
        '(matches solana-keygen).',
    );
    this.name = 'X402InvalidSolanaKeyError';
    this.reason = reason;
  }
}
