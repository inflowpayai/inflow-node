import { x402Client } from '@x402/core/client';
import type {
  AfterPaymentCreationHook,
  BeforePaymentCreationHook,
  ClientExtension,
  OnPaymentCreationFailureHook,
  OnPaymentResponseHook,
  PaymentPolicy,
} from '@x402/core/client';
import type { Network, PaymentPayload, PaymentRequired, SchemeNetworkClient } from '@x402/core/types';

import type {
  InflowPaymentPayload,
  PaymentRequirements,
  PaymentScheme,
  X402BuyerSupportedResponse,
} from '@inflowpayai/x402';
import { EXTRA_KEYS, INFLOW_AMOUNT_SCALE, SCHEMES } from '@inflowpayai/x402';
import { EXTENSION_REGISTRY, getExtension, setExtension, type SignContext } from '@inflowpayai/x402/extensions';

import { X402AdapterRoutingError } from './errors.js';
import { fromFoundationRequirements, toFoundationPayload } from './_foundation-bridge.js';
import { createInflowSigner } from './signer.js';
import type {
  BuyerLedgerBalance,
  InflowSigner,
  PreparedPayment,
  SignerOptions,
  SignOptions,
  SigningContext,
  X402PayloadResponse,
} from './types.js';

/**
 * Subclass of `@x402/core`'s `x402Client` that adds the InFlow MPC signing branch and the two-phase
 * {@link InflowClient.prepareInflowPayment} flow. Construct via {@link createInflowClient}.
 */
export class InflowClient extends x402Client {
  /**
   * The InFlow-signed branch of the routing decision. Kept private — callers compose by passing the {@link InflowClient}
   * to `x402HTTPClient` (and to `registerExactEvmScheme` / `registerExactSvmScheme` for foundation-signed networks).
   */
  private readonly inflowSigner: InflowSigner;
  /**
   * Ordered scheme preference used when picking among multiple InFlow-acceptable requirements. Sourced from the InFlow
   * signer at construction so the buyer's intent (`prefer: ['balance', 'exact']` by default) survives across the
   * override.
   */
  private readonly preferOrder: readonly PaymentScheme[];

  /**
   * Construct via {@link createInflowClient}. The factory primes the buyer capability cache before resolving, so the
   * routing decision in {@link InflowClient.createPaymentPayload} is synchronous against in-memory data. The constructor
   * is exported only so the class is referenceable for `instanceof` checks, generic constraints, and return types.
   *
   * @param inflowSigner - Primed InFlow signer carrying the buyer capability cache, MPC signing flow, and prefer order.
   * @internal
   */
  constructor(inflowSigner: InflowSigner) {
    super();
    this.inflowSigner = inflowSigner;
    this.preferOrder = inflowSigner.prefer;
  }

  /**
   * Routing override. InFlow signs when the buyer capability cache covers a requirement (preferred-scheme order);
   * otherwise the foundation signs and any registered extension handlers are folded into `payload.extensions`. A
   * `required: true` extension whose handler returns `null` throws.
   */
  override async createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload> {
    // All foundation/InFlow type translation goes through ./_foundation-bridge.ts; see that file for the rationale on
    // why these casts are safe under the V2 wire shape.
    const inflowMatch = await this.pickInflowMatchBalanceAware(fromFoundationRequirements(paymentRequired.accepts));
    if (inflowMatch !== null) {
      const context: SigningContext = {
        resource: paymentRequired.resource,
        x402Version: paymentRequired.x402Version,
        ...(paymentRequired.extensions !== undefined ? { extensions: paymentRequired.extensions } : {}),
      };
      const result = await this.inflowSigner.sign(inflowMatch, context);
      return toFoundationPayload(result.paymentPayload);
    }
    const payload = await super.createPaymentPayload(paymentRequired);
    // Foundation PaymentPayload is structurally assignable to InflowPaymentPayload (foundation `payload: Record<string,
    // unknown>` is the catch-all branch of `InflowPaymentPayloadData`; foundation `network: ${string}:${string}` is
    // assignable to InFlow's wider `network: string`). No cast needed here.
    const folded = foldInflowExtensions(payload, paymentRequired);
    return toFoundationPayload(folded);
  }

  /**
   * Two-phase signing flow for callers that want to surface pending- approval UI before the protected request is
   * replayed. Forwarded to the InFlow signer's `prepare()`; returns a {@link PreparedPayment} the caller can
   * `awaitPayload()` or `cancel()` independently.
   *
   * Has no foundation equivalent — `x402Client.createPaymentPayload` is one-shot. The handle is InFlow-specific and
   * only applies to requirements InFlow can sign.
   *
   * @param requirement - The chosen `PaymentRequirements` (re-exported from `@inflowpayai/x402`) — must match an entry
   *   in the InFlow buyer capability cache.
   * @param context - Seller-side {@link SigningContext}.
   * @param options - Per-call {@link SignOptions}.
   * @returns A {@link PreparedPayment} handle.
   * @throws {@link X402AdapterRoutingError} When the requirement is not in the InFlow buyer capability cache
   *   (foundation-signed requirements have no two-phase flow).
   */
  async prepareInflowPayment(
    requirement: PaymentRequirements,
    context: SigningContext,
    options?: SignOptions,
  ): Promise<PreparedPayment> {
    if (!this.inflowSigner.supports(requirement)) {
      throw new X402AdapterRoutingError(requirement.scheme, requirement.network);
    }
    return this.inflowSigner.prepare(requirement, context, options);
  }

  /**
   * Snapshot of the buyer-side capability cache — the `(scheme, network)` pairs this account can sign for. Honors
   * `@inflowpayai/x402-buyer`'s 60-min cache TTL. Use {@link InflowClient.selectInflowRequirement} to translate this
   * into a routing decision against a seller's `accepts[]`.
   */
  async getSupported(): Promise<X402BuyerSupportedResponse> {
    return this.inflowSigner.getSupported();
  }

  /**
   * Pick the buyer's preferred `accepts[]` entry the InFlow signer can sign, returned as an InFlow
   * `PaymentRequirements` (re-exported from `@inflowpayai/x402`). Walks {@link createInflowClient}'s configured `prefer`
   * order against the decoded `PaymentRequired`. Returns `null` when no entry matches — caller should fall back to the
   * foundation flow via {@link InflowClient.createPaymentPayload} or surface a "no InFlow match" error.
   *
   * Balance-aware: when the winning scheme is `balance`/`inflow:1` and the seller advertises several assets, it fetches
   * the buyer's InFlow ledger balances (`GET /v1/balances`) and prefers an asset the buyer can actually cover —
   * avoiding a guaranteed `INSUFFICIENT_FUNDS` rejection when the seller's first-listed asset happens to be one the
   * buyer doesn't hold. Degrades safely: a single option, a non-`balance` winning scheme, an unreadable balance, or no
   * affordable asset all fall back to the first preferred match, leaving the server as the authority on sufficiency.
   *
   * Returns a promise because it may hit the balances endpoint; the `(scheme, network)` capability lookup itself is
   * synchronous against the cache primed by {@link createInflowClient}.
   */
  async selectInflowRequirement(paymentRequired: PaymentRequired): Promise<PaymentRequirements | null> {
    return this.pickInflowMatchBalanceAware(fromFoundationRequirements(paymentRequired.accepts));
  }

  /**
   * One-shot poll of `GET /v1/transactions/{transactionId}/x402`. Use when the caller does not own the originating
   * {@link PreparedPayment} (e.g. a CLI resumption in a new process). For in-process polling, prefer
   * `PreparedPayment.awaitPayload`.
   */
  async getX402Payload(transactionId: string): Promise<X402PayloadResponse> {
    return this.inflowSigner.getX402Payload(transactionId);
  }

  /**
   * Fire-and-forget cancel of `POST /v1/approvals/{approvalId}/cancel`. Always resolves on server-side outcomes; the
   * cancel may succeed, no-op (the approval already terminated), or fail — callers do not observe the difference. Use
   * when the caller does not own the originating {@link PreparedPayment}. For in-process cancels, prefer
   * `PreparedPayment.cancel`.
   */
  async cancelApproval(approvalId: string): Promise<void> {
    return this.inflowSigner.cancelApproval(approvalId);
  }

  // The eight overrides below preserve foundation `x402Client` behavior
  // verbatim and only narrow the return type to `this` so chaining
  // stays in the {@link InflowClient} subclass.

  override register(network: Network, schemeNetworkClient: SchemeNetworkClient): this {
    super.register(network, schemeNetworkClient);
    return this;
  }

  override registerV1(network: string, schemeNetworkClient: SchemeNetworkClient): this {
    super.registerV1(network, schemeNetworkClient);
    return this;
  }

  override registerPolicy(policy: PaymentPolicy): this {
    super.registerPolicy(policy);
    return this;
  }

  override registerExtension(extension: ClientExtension): this {
    super.registerExtension(extension);
    return this;
  }

  override onBeforePaymentCreation(hook: BeforePaymentCreationHook): this {
    super.onBeforePaymentCreation(hook);
    return this;
  }

  override onAfterPaymentCreation(hook: AfterPaymentCreationHook): this {
    super.onAfterPaymentCreation(hook);
    return this;
  }

  override onPaymentCreationFailure(hook: OnPaymentCreationFailureHook): this {
    super.onPaymentCreationFailure(hook);
    return this;
  }

  override onPaymentResponse(hook: OnPaymentResponseHook): this {
    super.onPaymentResponse(hook);
    return this;
  }

  /**
   * Pick the buyer's preferred `accepts[]` entry the InFlow signer can handle, balance-aware. Preserves the
   * preferred-scheme precedence exactly: the first scheme in {@link InflowClient.preferOrder} that has any signable
   * entry wins, and selection never jumps to a less-preferred scheme. Within the winning scheme, when it is
   * `balance`/`inflow:1` and more than one asset is offered, prefer the first the buyer can cover on the InFlow ledger.
   * If balances can't be read, or none are sufficient, it returns the first preferred match, leaving the server to
   * issue the authoritative `INSUFFICIENT_FUNDS`.
   */
  private async pickInflowMatchBalanceAware(
    accepts: readonly PaymentRequirements[],
  ): Promise<PaymentRequirements | null> {
    for (const scheme of this.preferOrder) {
      const matches = accepts.filter((r) => r.scheme === scheme && this.inflowSigner.supports(r));
      if (matches.length === 0) continue;
      if (scheme === SCHEMES.BALANCE && matches.length > 1) {
        const balances = await this.loadLedgerBalances();
        if (balances !== undefined) {
          const affordable = matches.find((r) => ledgerCovers(balances, r));
          if (affordable !== undefined) return affordable;
        }
      }
      // Single option, non-ledger scheme, unreadable balances, or nothing affordable: first match.
      return matches[0] ?? null;
    }
    return null;
  }

  /**
   * Fetch the buyer's InFlow ledger balances as a `currency -> available (atomic, {@link INFLOW_AMOUNT_SCALE})` map.
   * Best-effort: returns `undefined` on any failure so callers degrade to balance-unaware selection rather than
   * blocking a pay on a balances-endpoint hiccup.
   */
  private async loadLedgerBalances(): Promise<Map<string, bigint> | undefined> {
    let raw: readonly BuyerLedgerBalance[];
    try {
      raw = await this.inflowSigner.getBalances();
    } catch {
      return undefined;
    }
    const byCurrency = new Map<string, bigint>();
    for (const b of raw) {
      const atomic = decimalToAtomic(b.available, INFLOW_AMOUNT_SCALE);
      if (atomic !== undefined) byCurrency.set(b.currency, atomic);
    }
    return byCurrency;
  }
}

/**
 * True when the buyer's ledger balance for a `balance`-scheme requirement's asset covers its required amount. The
 * requirement's `amount` is already atomic at {@link INFLOW_AMOUNT_SCALE} and the balance map is normalized to the same
 * scale, so the comparison is a direct `bigint` compare. Returns `false` when the asset name is missing/unmatched or
 * the amount is unparseable — i.e. "can't prove coverage" never blocks a viable row, it just isn't preferred.
 */
function ledgerCovers(balances: Map<string, bigint>, requirement: PaymentRequirements): boolean {
  const assetName = requirement.extra?.[EXTRA_KEYS.ASSET_NAME];
  if (typeof assetName !== 'string') return false;
  const available = balances.get(assetName);
  if (available === undefined) return false;
  let required: bigint;
  try {
    required = BigInt(requirement.amount);
  } catch {
    return false;
  }
  return available >= required;
}

/**
 * Convert a non-negative decimal string (e.g. `'78.3757'`) to an atomic `bigint` at `scale` decimal places. The
 * fractional part is right-padded with zeros and truncated to `scale` digits (the ledger never exposes more precision
 * than its scale). Returns `undefined` for anything that isn't a plain decimal number.
 */
function decimalToAtomic(value: string, scale: number): bigint | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) return undefined;
  const sign = match[1] ?? '';
  const intPart = match[2] ?? '0';
  const fracRaw = match[3] ?? '';
  const frac = `${fracRaw}${'0'.repeat(scale)}`.slice(0, scale);
  const magnitude = BigInt(`${intPart}${frac}`);
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * Async factory for {@link InflowClient}. Constructs the InFlow signer (which primes the buyer-supported cache) and
 * attaches it to a fresh `InflowClient` instance.
 *
 * Foundation-managed scheme registrations (`registerExactEvmScheme(client, …)`, `registerExactSvmScheme(client, …)`)
 * are applied to the returned instance by the caller after this factory resolves.
 *
 * @param options - {@link SignerOptions}.
 * @returns A primed {@link InflowClient} ready for `x402HTTPClient` and any further foundation scheme registrations.
 */
export async function createInflowClient(options: SignerOptions): Promise<InflowClient> {
  const inflowSigner = await createInflowSigner(options);
  return new InflowClient(inflowSigner);
}

/**
 * Run every handler in `EXTENSION_REGISTRY` against the seller's `paymentRequired.extensions`. For each declared
 * extension whose handler returns a non-`null` payload entry, fold the entry into `paymentPayload.extensions`. Required
 * declarations whose handler returns `null` throw.
 *
 * The foundation `x402Client` does not know about `EXTENSION_REGISTRY`, so this fold-up runs only on the
 * foundation-signed branch of the routing decision. The InFlow-signed branch is unaffected — the InFlow server already
 * handled extensions when constructing the server-side payload.
 */
function foldInflowExtensions(
  paymentPayload: InflowPaymentPayload,
  paymentRequired: PaymentRequired,
): InflowPaymentPayload {
  const declared = paymentRequired.extensions;
  if (declared === undefined) return paymentPayload;

  const signContext: SignContext = {};
  let extensions: Record<string, unknown> | undefined = paymentPayload.extensions;
  for (const handler of EXTENSION_REGISTRY.values()) {
    const declaration = getExtension(declared, handler);
    if (declaration === undefined) continue;
    const entry = handler.buildPayloadEntry(declaration, signContext);
    if (entry !== null) {
      extensions = setExtension(extensions, handler, entry);
      continue;
    }
    const required =
      declaration !== null &&
      typeof declaration === 'object' &&
      'required' in declaration &&
      declaration.required === true;
    if (required) {
      throw new Error(
        `InflowClient: extension "${handler.name}" is declared as required but no payload entry was produced`,
      );
    }
  }
  if (extensions === undefined) return paymentPayload;
  return { ...paymentPayload, extensions };
}
