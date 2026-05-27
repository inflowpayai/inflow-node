import type {
  InflowAnonymousClientOptions,
  InflowBearerClientOptions,
  InflowClientOptions,
  InflowPaymentPayload,
  InstrumentType,
  PaymentRequirements,
  PaymentScheme,
  ResourceInfo,
  X402BuyerSupportedResponse,
} from '@inflowpayai/x402';

/**
 * Status of an x402 transaction's signing flow. `'INITIATED'` means the server-side approval is still pending. Any
 * other value indicates the approval has cleared — successful when paired with an `encodedPayload`, failed otherwise.
 * The SDK treats values other than `'INITIATED'` opaquely so new statuses don't require client changes.
 */
export type TransactionStatus = 'INITIATED' | (string & {});

/**
 * Status of a buyer-side approval. `'APPROVED'` means the server has synchronously signed; `'PENDING'` means the buyer
 * must approve in their dashboard. Other terminal values (declined, cancelled, etc.) are surfaced verbatim and treated
 * opaquely.
 */
export type ApprovalStatus = 'APPROVED' | 'PENDING' | (string & {});

/**
 * Response body of `POST /v1/transactions/x402`. The buyer creates a transaction and Approval; this is what the server
 * returns synchronously.
 */
export interface X402TransactionResponse {
  approvalId: string;
  approvalStatus: ApprovalStatus;
  transactionId: string;
  amount: string;
  currency: string;
  resource?: ResourceInfo;
}

/**
 * Response body of `GET /v1/transactions/{transactionId}/x402`. While `status === 'INITIATED'`, neither
 * `encodedPayload` nor `paymentPayload` are populated. Once the server has signed, both appear together.
 */
export interface X402PayloadResponse {
  status: TransactionStatus;
  encodedPayload?: string;
  paymentPayload?: InflowPaymentPayload;
}

/**
 * Context the buyer learned from the seller's 402 response, threaded into `prepare()` / `sign()` so the server-side
 * `POST /v1/transactions/x402` endpoint receives the seller's exact `resource` and `x402Version`.
 */
export interface SigningContext {
  /** From `PaymentRequired.resource`. */
  resource: ResourceInfo;
  /** From `PaymentRequired.x402Version`. Should be `2`. */
  x402Version: number;
  /**
   * From `PaymentRequired.extensions`. The signer dispatches handlers registered in the core extensions registry for
   * the names it sees here.
   */
  extensions?: Record<string, unknown>;
}

/**
 * Output of a successful signing. `encodedPayload` is the base64 string to set as the `PAYMENT-SIGNATURE` header — the
 * SDK never re-encodes the server-produced value.
 */
export interface EncodedPayment {
  /** Base64-encoded `InflowPaymentPayload` (re-exported from `@inflowpayai/x402`). */
  encodedPayload: string;
  /** Parsed payload for inspection. */
  paymentPayload: InflowPaymentPayload;
  /**
   * Server-side transaction id for correlation. Present when the InFlow-signed branch produced this payment; absent on
   * the foundation-signed branch (no InFlow Approval was created).
   */
  transactionId?: string;
}

/** Per-call options accepted by every signing entry point. */
export interface SignOptions {
  /**
   * Poll cadence while approval is `'INITIATED'`. Default 5000 ms (fixed — no exponential backoff, no jitter; the
   * polling loop is itself the retry mechanism for the approval window).
   */
  pollIntervalMs?: number;
  /**
   * Hard timeout for the full sign / `awaitPayload` call. Default 900 000 ms (15 minutes) — matches the server-side
   * approval expiry.
   */
  timeoutMs?: number;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /**
   * Caller-supplied payment identifier forwarded to the server's `remotePaymentId` field. Validated client-side via the
   * `payment-identifier` extension rules (16–128 chars, `^[a-zA-Z0-9_-]+$`); invalid values throw
   * {@link X402PaymentIdFormatError} before any server round trip.
   */
  paymentId?: string;
}

/**
 * Constructor options for {@link createInflowClient}. Inherits the three options shapes accepted by `InflowHttpClient`'s
 * overloaded constructor — pass any one of `InflowClientOptions` (API key), `InflowAnonymousClientOptions` (no auth
 * header), or `InflowBearerClientOptions` (OAuth Bearer via `getAccessToken` callback) — plus the buyer-specific
 * `prefer` / `instrument` / `signDefaults` fields.
 */
export type SignerOptions = (InflowClientOptions | InflowAnonymousClientOptions | InflowBearerClientOptions) & {
  /**
   * Ordered scheme preference used when picking among multiple InFlow-acceptable requirements inside
   * {@link InflowClient.createPaymentPayload}. Default `['balance', 'exact']`.
   */
  prefer?: PaymentScheme[];
  /** Reserved instrument-scheme configuration. */
  instrument?: {
    id?: string;
    types?: InstrumentType[];
  };
  /** Default poll / timeout / paymentId values applied to every signing call. */
  signDefaults?: SignOptions;
};

/**
 * Handle returned by {@link InflowClient.prepareInflowPayment}. The transaction + approval have already been created
 * server-side; the caller decides when to await the signed payload.
 */
export interface PreparedPayment {
  readonly transactionId: string;
  readonly approvalId: string;
  /**
   * Poll `GET /v1/transactions/{transactionId}/x402` at `pollIntervalMs` cadence until the server has signed, the call
   * times out, or the caller's `AbortSignal` aborts.
   *
   * @param options - Per-call overrides. Concurrent callers share the underlying loop; only the FIRST call's
   *   `pollIntervalMs` / `timeoutMs` are honored.
   * @returns The signed {@link EncodedPayment}.
   * @throws {@link X402ApprovalFailedError} When the server moves out of `'INITIATED'` without producing an
   *   `encodedPayload`.
   * @throws {@link X402ApprovalTimeoutError} When wall-clock exceeds `timeoutMs` or the caller's `signal` aborts.
   */
  awaitPayload(options?: SignOptions): Promise<EncodedPayment>;
  /**
   * One-shot poll: returns the current {@link TransactionStatus} without waiting.
   *
   * @returns The latest status reported by the server.
   */
  status(): Promise<TransactionStatus>;
  /**
   * Best-effort cancel of the underlying server-side approval. Calls `POST /v1/approvals/{approvalId}/cancel`.
   * **Fire-and-forget by design** — always resolves, never rejects. Use to release a `PreparedPayment` the caller no
   * longer intends to await.
   *
   * @returns A promise that always resolves.
   */
  cancel(): Promise<void>;
}

/**
 * Minimal buyer-side signer contract. Implementation detail of {@link InflowClient}; not re-exported from the package
 * barrel.
 *
 * @internal
 */
export interface Signer {
  /** Ordered scheme preference this signer would like callers to honor. */
  readonly prefer: readonly PaymentScheme[];
  /**
   * Set of extension names this signer can satisfy on the buyer side. Used to filter `accepts[]` entries whose
   * `PaymentRequired` declares a `required: true` extension this signer cannot handle.
   */
  readonly extensionsHandled: ReadonlySet<string>;
  /**
   * Synchronous predicate: does this signer know how to sign the given requirement?
   *
   * @param requirement - The candidate {@link PaymentRequirements}.
   * @returns `true` if `sign(requirement, ctx)` is expected to succeed.
   */
  supports(requirement: PaymentRequirements): boolean;
  /**
   * Single-shot signing. Produces a base64-encoded {@link InflowPaymentPayload} ready to set as the `PAYMENT-SIGNATURE`
   * header.
   *
   * @param requirement - The chosen {@link PaymentRequirements}.
   * @param context - Seller-side {@link SigningContext} (resource + `x402Version` + extensions declarations).
   * @param options - Per-call {@link SignOptions}.
   * @returns The signed {@link EncodedPayment}.
   */
  sign(requirement: PaymentRequirements, context: SigningContext, options?: SignOptions): Promise<EncodedPayment>;
}

/**
 * InFlow-specific buyer signer. Adds the InFlow-server capability table, priming hooks, and a two-phase `prepare()` /
 * `awaitPayload()` flow for callers that want to surface pending-approval UI before the protected request.
 * Implementation detail of {@link InflowClient}; not re-exported from the package barrel.
 *
 * @internal
 */
export interface InflowSigner extends Signer {
  /**
   * Idempotent no-op for callers that have a long-lived signer and want to assert readiness explicitly. The async
   * factory has already primed the capability cache; `ready()` exists for ergonomics only.
   *
   * @returns A resolved promise.
   */
  ready(): Promise<void>;
  /**
   * Return the cached buyer capability set. 60-min TTL.
   *
   * @returns The {@link X402BuyerSupportedResponse}.
   */
  getSupported(): Promise<X402BuyerSupportedResponse>;
  /**
   * Force a refetch of the buyer capability table.
   *
   * @returns The freshly fetched {@link X402BuyerSupportedResponse}.
   */
  refreshSupported(): Promise<X402BuyerSupportedResponse>;
  /**
   * Callers loop at their own cadence.
   *
   * @internal
   */
  getX402Payload(transactionId: string): Promise<X402PayloadResponse>;
  /**
   * Swallows server-side errors; rethrows auth-callback rejections verbatim.
   *
   * @internal
   */
  cancelApproval(approvalId: string): Promise<void>;
  /**
   * Kick off the buyer's transaction and Approval and return a handle the caller can await independently.
   *
   * @param requirement - The chosen {@link PaymentRequirements}.
   * @param context - Seller-side {@link SigningContext}.
   * @param options - Per-call {@link SignOptions}.
   * @returns A {@link PreparedPayment} handle.
   * @throws {@link X402PaymentIdFormatError} When `options.paymentId` is set but doesn't satisfy `validatePaymentId`.
   */
  prepare(requirement: PaymentRequirements, context: SigningContext, options?: SignOptions): Promise<PreparedPayment>;
}
