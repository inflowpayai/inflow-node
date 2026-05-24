/**
 * Per-call context threaded into {@link ExtensionHandler.buildDeclaration}. Reserved for forward compatibility: handlers
 * may inspect fields here in future revisions. The seller's `inflowAccepts` currently passes `{}`.
 */
export type DeclarationContext = Record<string, never>;

/**
 * Per-call context threaded into {@link ExtensionHandler.buildPayloadEntry}. Populated by the buyer signer when
 * constructing a `PaymentPayload`.
 */
export interface SignContext {
  /**
   * Caller-supplied payment identifier (from `SignOptions.paymentId`) when the SDK writes the extensions map directly —
   * i.e. on the foundation-signed branch. Absent on the InFlow-signed branch, where the server embeds the identifier
   * server-side.
   */
  providedPaymentId?: string;
}

/**
 * Pluggable handler for one protocol extension. Sellers call `buildDeclaration` to populate
 * `PaymentRequired.extensions[name]`; buyers call `readDeclaration` to parse what the server emitted, and
 * `buildPayloadEntry` to produce the corresponding `PaymentPayload.extensions[name]` value.
 *
 * @typeParam TDeclaration - Shape of the declaration object the seller emits and the buyer reads.
 * @typeParam TPayloadEntry - Shape of the per-payload entry the buyer emits.
 */
export interface ExtensionHandler<TDeclaration, TPayloadEntry> {
  /** Extension name, matching the wire key in `extensions[]` maps. */
  readonly name: string;
  /**
   * Build the per-response declaration. Return `null` to omit this extension from the response entirely.
   *
   * @param context - {@link DeclarationContext}.
   * @returns The declaration value, or `null`.
   */
  buildDeclaration(context: DeclarationContext): TDeclaration | null;
  /**
   * Parse a declaration emitted by a server. Implementations should be defensive: anything that doesn't match the
   * expected shape returns `null`.
   *
   * @param decl - The raw value read from `PaymentRequired.extensions[name]`.
   * @returns The parsed declaration, or `null` when the input was missing or malformed.
   */
  readDeclaration(decl: unknown): TDeclaration | null;
  /**
   * Build the per-payload entry. Return `null` to skip embedding for this call — common when the declaration was
   * `required: false` and the caller did not opt in.
   *
   * @param declaration - The parsed declaration the server emitted on the matching 402.
   * @param context - {@link SignContext}.
   * @returns The payload-entry value, or `null` to omit.
   */
  buildPayloadEntry(declaration: TDeclaration, context: SignContext): TPayloadEntry | null;
}
