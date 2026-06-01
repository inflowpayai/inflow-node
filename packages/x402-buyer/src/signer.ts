import { InflowApiError, InflowHttpClient } from '@inflowpayai/x402';
import type {
  InflowPaymentPayload,
  PaymentRequirements,
  PaymentScheme,
  X402BuyerSupportedResponse,
} from '@inflowpayai/x402';
import { EXTENSION_REGISTRY, validatePaymentId } from '@inflowpayai/x402/extensions';

import {
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
        out.push({ currency: b.currency, available: b.available });
      }
    }
    return out;
  }

  async function prepare(
    requirement: PaymentRequirements,
    context: SigningContext,
    callOptions?: SignOptions,
  ): Promise<PreparedPayment> {
    const merged = { ...options.signDefaults, ...callOptions };
    if (merged.paymentId !== undefined && !validatePaymentId(merged.paymentId)) {
      throw new X402PaymentIdFormatError(merged.paymentId);
    }
    const body = {
      accept: requirement,
      resource: context.resource,
      x402Version: context.x402Version,
      ...(merged.paymentId !== undefined ? { remotePaymentId: merged.paymentId } : {}),
    };
    // Retries disabled: `POST /v1/transactions/x402` is idempotent only when
    // the caller supplies a `remotePaymentId` (server-side `putIfAbsent`).
    // Without that, a transparent 5xx retry would create a second Approval
    // and Transaction while the first one ages out at the 15-min expiry.
    // The buyer signer's polling loop is itself the retry mechanism for the
    // approval-window patience; transport-level retry here would be unsafe.
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
      // Short-circuit for the synchronous-approval path: when the server
      // signed during `POST /v1/transactions/x402` (approvalStatus = APPROVED),
      // the very first GET should already have the payload; the loop is
      // still robust to a missed first poll.
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

/**
 * Single `AbortSignal` fired when any of the inputs aborts. Uses native `AbortSignal.any` on Node 20.3+; falls back to
 * a manual fan-in otherwise.
 */
function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  // Fast path for the single-signal case so the caller observes that signal's `.reason` unchanged. Avoids the
  // `live[0]!` non-null assertion AGENTS.md §Conventions prohibits — under `noUncheckedIndexedAccess`, indexed
  // access on the filtered array still types as `AbortSignal | undefined`.
  const [first, ...rest] = live;
  if (first !== undefined && rest.length === 0) return first;
  // Prefer native `AbortSignal.any` (Node 20.3+); fall back to a manual fan-in. The single-level cast lets the
  // feature detect typecheck without reaching for `as unknown as`.
  const anyFn = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn(live);
  // Manual fan-in. When any input aborts, fire the controller and remove the listeners we added to the siblings —
  // otherwise the siblings hold references to a closure that's no longer useful, and a long-lived composed signal
  // would accumulate dead listeners on long-lived parents.
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  const fire = (reason: unknown): void => {
    controller.abort(reason);
    for (const c of cleanups) c();
  };
  for (const s of live) {
    if (s.aborted) {
      fire(s.reason);
      return controller.signal;
    }
    const handler = (): void => fire(s.reason);
    s.addEventListener('abort', handler, { once: true });
    cleanups.push(() => s.removeEventListener('abort', handler));
  }
  return controller.signal;
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
  const { pollOnce, buildEncodedPayment, approvalId, pollIntervalMs, timeoutMs, signal } = input;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const isAborted = (): boolean => signal !== undefined && signal.aborted;

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
      if (signal !== undefined && signal.aborted) {
        throw new X402ApprovalTimeoutError(approvalId, timeoutMs);
      }
      void err;
      // 5xx / network error → swallow; sleep and retry.
      response = undefined;
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
        return buildEncodedPayment(response.encodedPayload as string, response.paymentPayload as InflowPaymentPayload);
      }
    }
    if (firstPoll) {
      firstPoll = false;
      continue;
    }
    await sleep(pollIntervalMs, signal);
  }
  throw new X402ApprovalTimeoutError(approvalId, timeoutMs);
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
    const timer = setTimeout(resolve, ms);
    if (signal !== undefined) {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}
