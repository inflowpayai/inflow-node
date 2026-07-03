import { decodeCredential, encode, InflowApiError, MppClient } from '@inflowpayai/mpp';
import type { MppChallenge, MppCredential, MppTransactionResponse } from '@inflowpayai/mpp';

import {
  MppMalformedCredentialError,
  MppPaymentCancelledError,
  MppPaymentExpiredError,
  MppPaymentFailedError,
  MppPaymentTimeoutError,
} from './errors.js';
import type { FulfilChallenge, FulfilOptions, Fulfiller, InflowBuyerParameters } from './types.js';

/** Poll cadence (ms) used when a `pending` response advertises no `retryAfterSeconds`. */
const DEFAULT_POLL_INTERVAL_MS = 5000;
/** Total pending → ready budget (ms). Matches the server-side approval expiry (15 minutes). */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Build the approval-cancel path for a backing approval id. */
const approvalCancelPath = (approvalId: string): string => `/v1/approvals/${approvalId}/cancel`;

/**
 * Construct the {@link Fulfiller} that drives a parsed challenge through the InFlow buyer endpoints. Owns one
 * {@link MppClient} and the set of in-flight poll controllers so {@link Fulfiller.cleanup} can abort them all.
 *
 * @param parameters - Auth, environment, and polling knobs.
 * @returns A {@link Fulfiller}.
 * @internal
 */
export function createFulfiller(parameters: InflowBuyerParameters): Fulfiller {
  // Split the polling knobs off the auth/environment shape; the remainder is exactly an `MppClient` options object
  // (one of the three auth variants), so it passes straight through whether the caller supplied `apiKey` or
  // `getAccessToken`.
  const { pollIntervalMs, timeoutMs, ...clientOptions } = parameters;
  const client = new MppClient(clientOptions);
  const defaultPollIntervalMs = pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const defaultTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // In-flight poll controllers, aborted en masse by `cleanup()`.
  const active = new Set<AbortController>();

  async function cancelApproval(approvalId: string): Promise<void> {
    try {
      await client.http.post(approvalCancelPath(approvalId), undefined, { retries: 0 });
    } catch (err) {
      // A server-side outcome (already-terminal approval, etc.) surfaces as InflowApiError — swallow it; cancellation
      // is best-effort and the caller does not observe the difference. Non-API errors (programmer error) propagate.
      if (err instanceof InflowApiError) return;
      throw err;
    }
  }

  async function fulfil(
    challenge: FulfilChallenge,
    options: Record<string, unknown>,
    callOptions?: FulfilOptions,
  ): Promise<MppCredential> {
    const controller = new AbortController();
    active.add(controller);
    const signal = composeSignals(callOptions?.signal, controller.signal);
    const pollIntervalMs = callOptions?.pollIntervalMs ?? defaultPollIntervalMs;
    const timeoutMs = callOptions?.timeoutMs ?? defaultTimeoutMs;

    let approvalId: string | undefined;
    try {
      const created = await client.createTransaction(
        { challenge: toWireChallenge(challenge), options },
        { retries: 0, signal },
      );
      approvalId = created.approvalId;
      return await resolve(created, signal, pollIntervalMs, timeoutMs);
    } catch (err) {
      // Fire-and-forget cancel of the backing approval; never let it mask the original error.
      if (approvalId !== undefined) void cancelApproval(approvalId).catch(() => undefined);
      throw err;
    } finally {
      active.delete(controller);
    }
  }

  /** Walk the transaction state machine, polling while `pending`, until a terminal state. */
  async function resolve(
    initial: MppTransactionResponse,
    signal: AbortSignal,
    pollIntervalMs: number,
    timeoutMs: number,
  ): Promise<MppCredential> {
    const deadline = Date.now() + timeoutMs;
    let current = initial;

    for (;;) {
      let approvalId: string | undefined;
      switch (current.state) {
        case 'ready':
          return decodeReady(current);
        case 'failed':
          throw new MppPaymentFailedError(current.problem);
        case 'expired':
          throw new MppPaymentExpiredError(current.transactionId);
        case 'pending':
          approvalId = current.approvalId;
          break;
      }

      // `pending` without a transaction id can't be polled — treat as a malformed server response rather than spin.
      if (current.transactionId === undefined) {
        throw new MppMalformedCredentialError('pending response carried no transactionId to poll');
      }
      throwIfPaymentCancelled(signal, approvalId);
      if (Date.now() >= deadline) throw new MppPaymentTimeoutError(timeoutMs, current.transactionId);

      const advisedMs = current.retryAfterSeconds !== undefined ? current.retryAfterSeconds * 1000 : pollIntervalMs;
      const remainingMs = deadline - Date.now();
      await sleep(Math.max(0, Math.min(advisedMs, remainingMs)), signal);
      throwIfPaymentCancelled(signal, approvalId);
      if (Date.now() >= deadline) throw new MppPaymentTimeoutError(timeoutMs, current.transactionId);

      current = await client.getTransaction(current.transactionId, { retries: 0, signal });
    }
  }

  function cleanup(): void {
    for (const controller of active) controller.abort();
    active.clear();
  }

  return { fulfil, cancelApproval, cleanup };
}

function throwIfPaymentCancelled(signal: AbortSignal, approvalId: string | undefined): void {
  if (signal.aborted) throw new MppPaymentCancelledError(approvalId);
}

/**
 * Decode the server-produced credential from a `ready` response. The credential is forwarded verbatim — the buyer does
 * not synthesise `source` and does not reshape `payload` (which carries the server-stamped `transactionId`).
 */
function decodeReady(response: MppTransactionResponse): MppCredential {
  if (response.credential === undefined) {
    throw new MppMalformedCredentialError('ready response carried no credential');
  }
  try {
    return decodeCredential(response.credential);
  } catch (err) {
    throw new MppMalformedCredentialError('failed to decode the server credential', err);
  }
}

/**
 * Build the server's wire `MppChallenge` from the parsed `mppx` challenge. `mppx` hands us `request` as a decoded
 * object; the server expects it base64url-JCS encoded, so re-encode it here (byte-parity with the server codec).
 */
function toWireChallenge(challenge: FulfilChallenge): MppChallenge {
  return {
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    request: encode(challenge.request),
    ...(challenge.expires !== undefined ? { expires: challenge.expires } : {}),
    ...(challenge.description !== undefined ? { description: challenge.description } : {}),
    ...(challenge.digest !== undefined ? { digest: challenge.digest } : {}),
  };
}

/** Abortable delay. Resolves early (does not reject) when `signal` aborts; the caller re-checks `signal.aborted`. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    // Symmetric teardown: the timer path removes the abort listener and the abort path clears the timer, so neither
    // outlives this sleep. (The signal is shared across every poll iteration of one fulfilment, so a listener left
    // attached per sleep would accumulate for the whole pending → ready budget.)
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A single {@link AbortSignal} that fires when either input aborts. When no caller signal is supplied, the internal
 * controller signal is returned directly. Uses native `AbortSignal.any` (available on the supported Node ≥22).
 */
function composeSignals(caller: AbortSignal | undefined, own: AbortSignal): AbortSignal {
  if (caller === undefined) return own;
  return AbortSignal.any([caller, own]);
}
