import {
  ASSET_TRANSFER_METHODS,
  EXTRA_KEYS,
  SCHEMES,
  InflowApiError,
  InflowHttpClient,
  normalizeDecimalString,
} from '@inflowpayai/x402';
import type {
  InflowPaymentPayload,
  PaymentRequirements,
  PaymentScheme,
  RequestOptions,
  X402BuyerSupportedResponse,
} from '@inflowpayai/x402';
import { EXTENSION_REGISTRY, validatePaymentId } from '@inflowpayai/x402/extensions';
import { getExtra } from '@inflowpayai/x402/extras';

import {
  X402AdapterRoutingError,
  X402ApprovalCancelledError,
  X402ApprovalFailedError,
  X402ApprovalTimeoutError,
  X402PaymentIdFormatError,
} from './errors.js';
import type {
  ApprovalStatus,
  BuyerLedgerBalance,
  EncodedPayment,
  InflowSigner,
  PaymentStatusResponse,
  PreparedPayment,
  SignerOptions,
  SignOptions,
  SigningContext,
  TransactionStatus,
  X402PayloadResponse,
  X402TransactionResponse,
} from './types.js';

const SUPPORTED_PATH = '/v1/transactions/x402-supported';
const BALANCES_PATH = '/v1/balances';
const TRANSACTIONS_PATH = '/v1/transactions/x402';
const APPROVAL_CANCEL_PATH = (id: string): string => `/v1/approvals/${id}/cancel`;
const TRANSACTION_X402_PATH = (id: string): string => `/v1/transactions/${id}/x402`;

const CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PREFER: readonly PaymentScheme[] = ['balance', 'exact'];
const APPROVAL_APPROVED: ApprovalStatus = 'APPROVED';

/**
 * Async factory for {@link InflowSigner}. Primes the buyer-supported cache before resolving so `supports()` is honestly
 * synchronous. Implementation detail of {@link createInflowClient}; not re-exported from the package barrel.
 *
 * @internal
 */
export async function createInflowSigner(options: SignerOptions): Promise<InflowSigner> {
  const http = new InflowHttpClient(options);
  const prefer = options.prefer ?? DEFAULT_PREFER;
  const extensionsHandled: ReadonlySet<string> = new Set(EXTENSION_REGISTRY.keys());

  interface CacheEntry<T> {
    value: T | undefined;
    expiresAt: number;
    inFlight: Promise<T> | undefined;
  }
  const supportedCache: CacheEntry<X402BuyerSupportedResponse> = {
    value: undefined,
    expiresAt: 0,
    inFlight: undefined,
  };

  async function fetchSupported(): Promise<X402BuyerSupportedResponse> {
    const fresh = await http.get<X402BuyerSupportedResponse>(SUPPORTED_PATH);
    supportedCache.value = fresh;
    supportedCache.expiresAt = Date.now() + CACHE_TTL_MS;
    return fresh;
  }

  function getSupported(): Promise<X402BuyerSupportedResponse> {
    if (supportedCache.value !== undefined && Date.now() < supportedCache.expiresAt) {
      return Promise.resolve(supportedCache.value);
    }
    if (supportedCache.inFlight !== undefined) return supportedCache.inFlight;
    const inFlight = fetchSupported().finally(() => {
      supportedCache.inFlight = undefined;
    });
    supportedCache.inFlight = inFlight;
    return inFlight;
  }

  /**
   * Reissues the fetch and atomically swaps in the new value on success. The previously cached value remains live until
   * the refresh resolves, so a transient failure does not flip `supports()` to false.
   */
  function refreshSupported(): Promise<X402BuyerSupportedResponse> {
    if (supportedCache.inFlight !== undefined) return supportedCache.inFlight;
    const inFlight = fetchSupported().finally(() => {
      supportedCache.inFlight = undefined;
    });
    supportedCache.inFlight = inFlight;
    return inFlight;
  }

  function supports(requirement: PaymentRequirements): boolean {
    if (getExtra(requirement.extra, EXTRA_KEYS.ASSET_TRANSFER_METHOD) === ASSET_TRANSFER_METHODS.PERMIT2) return false;
    const cached = supportedCache.value;
    if (cached === undefined) return false;
    return cached.kinds.some((k) => k.scheme === requirement.scheme && k.network === requirement.network);
  }

  // Shape of `GET /v1/balances`. Both fields are strings on the wire (`available` is serialized with
  // `@JsonFormat(shape = STRING)`; `currency` is the enum name, e.g. "USDC"). Typed loosely here and narrowed below
  // because the SDK only needs the (currency, available) pair for balance-aware requirement selection.
  interface BalancesApiResponse {
    balances?: { available?: string; currency?: string }[];
  }

  // Always fetches fresh: ledger balances are volatile and selection happens at most once per pay, so caching them
  // (unlike the long-lived capability table) would risk picking an asset the buyer no longer holds.
  async function getBalances(): Promise<readonly BuyerLedgerBalance[]> {
    const res = await http.get<BalancesApiResponse>(BALANCES_PATH);
    const list = Array.isArray(res.balances) ? res.balances : [];
    const out: BuyerLedgerBalance[] = [];
    for (const b of list) {
      if (typeof b.currency === 'string' && typeof b.available === 'string') {
        out.push({ currency: b.currency, available: normalizeDecimalString(b.available) });
      }
    }
    return out;
  }

  async function prepare(
    requirement: PaymentRequirements,
    context: SigningContext,
    callOptions?: SignOptions,
  ): Promise<PreparedPayment> {
    if (getExtra(requirement.extra, EXTRA_KEYS.ASSET_TRANSFER_METHOD) === ASSET_TRANSFER_METHODS.PERMIT2) {
      throw new X402AdapterRoutingError(requirement.scheme, requirement.network);
    }
    const merged = { ...options.signDefaults, ...callOptions };
    if (merged.paymentId !== undefined && !validatePaymentId(merged.paymentId)) {
      throw new X402PaymentIdFormatError(merged.paymentId);
    }
    const body = {
      ...(merged.transactionRequestExtensions ?? {}),
      accept: requirement,
      resource: context.resource,
      x402Version: context.x402Version,
      ...(requirement.scheme === SCHEMES.INSTRUMENT && options.instrument?.id !== undefined
        ? { instrumentId: options.instrument.id }
        : {}),
      ...(merged.paymentId !== undefined ? { remotePaymentId: merged.paymentId } : {}),
    };
    // Creation retries require a caller-managed identifier and server idempotency support.
    // Polling retries reuse an existing transaction; they do not repeat creation.
    const created = await http.post<X402TransactionResponse>(TRANSACTIONS_PATH, body, {
      retries: 0,
      ...(merged.signal !== undefined ? { signal: merged.signal } : {}),
    });
    return makePreparedPayment(http, created, merged);
  }

  async function sign(
    requirement: PaymentRequirements,
    context: SigningContext,
    callOptions?: SignOptions,
  ): Promise<EncodedPayment> {
    const prepared = await prepare(requirement, context, callOptions);
    try {
      return await prepared.awaitPayload(callOptions);
    } catch (err) {
      // Fire-and-forget cancel; never let it mask the original error.
      void prepared.cancel();
      throw err;
    }
  }

  async function getX402Payload(transactionId: string): Promise<X402PayloadResponse> {
    return http.get<X402PayloadResponse>(TRANSACTION_X402_PATH(transactionId), { retries: 0 });
  }

  async function getPaymentStatus(
    transactionId: string,
    requestOptions: RequestOptions = {},
  ): Promise<PaymentStatusResponse> {
    return http.get<PaymentStatusResponse>(`/v1/transactions/${encodeURIComponent(transactionId)}`, {
      ...requestOptions,
      retries: requestOptions.retries ?? 0,
    });
  }

  async function cancelApproval(approvalId: string): Promise<void> {
    try {
      await http.post(APPROVAL_CANCEL_PATH(approvalId), undefined, { retries: 0 });
    } catch (err) {
      if (err instanceof InflowApiError) return;
      throw err;
    }
  }

  // Prime the supported cache before returning so `supports()` is honest.
  await fetchSupported();

  const signer: InflowSigner = {
    prefer,
    extensionsHandled,
    supports,
    sign,
    prepare,
    ready: () => Promise.resolve(),
    getSupported,
    refreshSupported,
    getBalances,
    getX402Payload,
    getPaymentStatus,
    cancelApproval,
  };
  return signer;
}

/**
 * Construct the {@link PreparedPayment} returned by `prepare()`. The `awaitPayload` polling loop is created lazily on
 * first call; concurrent callers share the same in-flight promise.
 */
function makePreparedPayment(
  http: InflowHttpClient,
  created: X402TransactionResponse,
  preparedOptions: SignOptions,
): PreparedPayment {
  let awaitInFlight: Promise<EncodedPayment> | undefined;
  let cancelled = false;
  // Signal fired by `cancel()` to break the polling loop immediately.
  const cancelController = new AbortController();

  function buildEncodedPayment(encodedPayload: string, paymentPayload: InflowPaymentPayload): EncodedPayment {
    return { encodedPayload, paymentPayload, transactionId: created.transactionId };
  }

  async function pollOnce(signal?: AbortSignal): Promise<X402PayloadResponse> {
    return http.get<X402PayloadResponse>(TRANSACTION_X402_PATH(created.transactionId), {
      retries: 0,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async function awaitPayload(callOptions?: SignOptions): Promise<EncodedPayment> {
    if (cancelled) {
      throw new X402ApprovalCancelledError(created.approvalId);
    }
    if (awaitInFlight !== undefined) return awaitInFlight;
    const merged: SignOptions = { ...preparedOptions, ...callOptions };
    const pollIntervalMs = merged.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = merged.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const callerSignal = merged.signal;
    // The poll loop honours an abort from either the caller or `cancel()`.
    const signal = composeSignals(callerSignal, cancelController.signal);
    const promise = runPollLoop({
      pollOnce,
      buildEncodedPayment,
      approvalId: created.approvalId,
      pollIntervalMs,
      timeoutMs,
      signal,
      // An approved creation can already have a persisted payload. The loop
      // also waits when signing is still pending.
      createdApprovalStatus: created.approvalStatus,
    }).catch((err: unknown) => {
      if (cancelled) {
        throw new X402ApprovalCancelledError(created.approvalId);
      }
      throw err;
    });
    awaitInFlight = promise;
    promise.catch(() => {
      // Reset in-flight on rejection so a retry re-enters the loop instead
      // of replaying the same rejection.
      awaitInFlight = undefined;
    });
    return promise;
  }

  async function statusFn(): Promise<TransactionStatus> {
    const payload = await pollOnce();
    return payload.status;
  }

  async function cancel(): Promise<void> {
    // Client-side cancel: flip the flag and abort the poll loop *before*
    // touching the network. Any in-flight `awaitPayload()` rejects with
    // `X402ApprovalCancelledError` immediately. The server cancel is
    // fire-and-forget — errors never surface to the caller.
    cancelled = true;
    cancelController.abort();
    try {
      await http.post(APPROVAL_CANCEL_PATH(created.approvalId), undefined, { retries: 0 });
    } catch {
      // swallow
    }
  }

  return {
    transactionId: created.transactionId,
    approvalId: created.approvalId,
    awaitPayload,
    status: statusFn,
    cancel,
  };
}

function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}

/**
 * Poll loop core. Inspects `encodedPayload` presence first, then status: payload present → signed; status in
 * {@link TERMINAL_FAILURE_STATUSES} → failed; everything else → pending (including non-terminal statuses racing the
 * server's `encodedPayload` write). 5xx and network errors during a single poll are swallowed; the loop is itself the
 * retry mechanism.
 */
async function runPollLoop(input: {
  pollOnce: (signal?: AbortSignal) => Promise<X402PayloadResponse>;
  buildEncodedPayment: (encodedPayload: string, paymentPayload: InflowPaymentPayload) => EncodedPayment;
  approvalId: string;
  pollIntervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  createdApprovalStatus: ApprovalStatus;
}): Promise<EncodedPayment> {
  const { pollOnce, buildEncodedPayment, approvalId, pollIntervalMs, timeoutMs } = input;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const timeoutController = new AbortController();
  const signal = composeSignals(input.signal, timeoutController.signal);
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const isAborted = (): boolean => signal.aborted;

  try {
    if (isAborted()) {
      throw new X402ApprovalTimeoutError(approvalId, timeoutMs);
    }

    // Synchronous-approval path: skip the first sleep.
    let firstPoll = input.createdApprovalStatus === APPROVAL_APPROVED;

    while (Date.now() < deadline) {
      if (isAborted()) {
        throw new X402ApprovalTimeoutError(approvalId, timeoutMs);
      }
      let response: X402PayloadResponse | undefined;
      try {
        // Thread the caller signal so an in-flight GET aborts immediately on
        // caller cancel instead of running out the HTTP client's 30s default.
        response = await pollOnce(signal);
      } catch (err) {
        // If the abort fired, propagate as timeout/abort error instead of
        // silently sleeping and re-polling.
        if (signal.aborted) {
          throw new X402ApprovalTimeoutError(approvalId, timeoutMs);
        }
        if (
          !(err instanceof InflowApiError) ||
          !(err.httpStatus === 0 || err.httpStatus === 429 || err.httpStatus >= 500)
        )
          throw err;
        response = undefined;
      }
      if (isAborted() || Date.now() >= deadline) {
        throw new X402ApprovalTimeoutError(approvalId, timeoutMs);
      }
      if (response !== undefined) {
        const settled = evaluatePoll(response);
        if (settled === 'pending') {
          // Still INITIATED, or transitioned to a non-terminal/success state
          // whose `encodedPayload` write hasn't landed yet. Sleep and retry.
        } else if (settled === 'failed') {
          throw new X402ApprovalFailedError(approvalId, response.status);
        } else {
          // settled === 'signed' → response.encodedPayload && paymentPayload present.
          return buildEncodedPayment(
            response.encodedPayload as string,
            response.paymentPayload as InflowPaymentPayload,
          );
        }
      }
      if (firstPoll) {
        firstPoll = false;
        continue;
      }
      await sleep(pollIntervalMs, signal);
    }
    throw new X402ApprovalTimeoutError(approvalId, timeoutMs);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Terminal failure statuses produced by the InFlow `TransactionStatus` enum (see `inflow-server`
 * `datastore/local/TransactionStatus.java`). On any of these the poll loop rejects with `X402ApprovalFailedError`
 * without waiting for a payload — the payment will never settle.
 *
 * Any other status (`PENDING`, `PROCESSING`, success states racing the `encodedPayload` write) is treated as `pending`
 * so transient gaps between status flip and payload write don't poison the buyer.
 */
const TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'DECLINED',
  'EXPIRED',
  'GENERAL_ERROR',
  'INSUFFICIENT_FUNDS',
]);

function evaluatePoll(response: X402PayloadResponse): 'pending' | 'signed' | 'failed' {
  if (response.encodedPayload != null && response.paymentPayload != null) {
    return 'signed';
  }
  if (TERMINAL_FAILURE_STATUSES.has(response.status)) {
    return 'failed';
  }
  return 'pending';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(finish, ms);
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}
