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

import type { InflowPaymentPayload, PaymentRequirements, PaymentScheme } from '@inflowpayai/x402';
import { EXTENSION_REGISTRY, getExtension, setExtension, type SignContext } from '@inflowpayai/x402/extensions';

import { X402AdapterRoutingError } from './errors.js';
import { fromFoundationRequirements, toFoundationPayload } from './_foundation-bridge.js';
import { createInflowSigner } from './signer.js';
import type { InflowSigner, PreparedPayment, SignerOptions, SignOptions, SigningContext } from './types.js';

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
    const inflowMatch = this.pickInflowMatch(fromFoundationRequirements(paymentRequired.accepts));
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
   * Pick the buyer's preferred `accepts[]` entry the InFlow signer can handle. Walks {@link InflowClient.preferOrder}
   * and returns the first entry whose `(scheme, network)` is in the InFlow capability cache; returns `null` when no
   * entry matches (the foundation branch takes over).
   */
  private pickInflowMatch(accepts: readonly PaymentRequirements[]): PaymentRequirements | null {
    for (const scheme of this.preferOrder) {
      const match = accepts.find((r) => r.scheme === scheme && this.inflowSigner.supports(r));
      if (match !== undefined) return match;
    }
    return null;
  }
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
