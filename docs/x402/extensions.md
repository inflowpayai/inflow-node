# Extensions

How the x402 extension mechanism works in this SDK, and how to add a new extension.

## The `payment-identifier` extension

Spec: [docs.x402.org/extensions/payment-identifier](https://docs.x402.org/extensions/payment-identifier).

A `payment-identifier` is a 16–128-character string matching `^[a-zA-Z0-9_-]+$`. It's used as a server-side idempotency
key — retrying settlement against the same identifier is a no-op once the payment is already recorded.

### Wire shape

**Declaration** (in `PaymentRequired.extensions`):

```jsonc
{
  "extensions": {
    "payment-identifier": { "required": false },
  },
}
```

Today the seller always declares `required: false`. A future server revision may set `required: true` to require the
buyer to embed an ID.

**Payload entry** (in `PaymentPayload.extensions`):

```jsonc
{
  "extensions": {
    "payment-identifier": { "paymentId": "pay_abc1234567890_xyz" },
  },
}
```

The default ID format is `pay_<32 hex chars>` (36 chars total), but any string satisfying the regex + length rules is
valid.

### Server behavior

**InFlow never auto-generates a `payment-identifier`.** The extension is an opt-in idempotency hint — the buyer asks for
it, the server echoes it back, and the facilitator dedupes retries keyed on the identifier. If the caller doesn't supply
one, no `payment-identifier` is embedded and there is nothing to dedupe on — retries produce fresh transactions.

Rationale:

- The foundation spec scopes the extension as opt-in (`required: false` by default). Auto-attaching imposes it on
  callers who never asked.
- For Solana the on-chain Memo v2 instruction is always emitted (foundation parity) for transaction-uniqueness, but it
  carries the seller's `extra.memo` if declared, or a random hex nonce otherwise — independent of whether the off-chain
  `payment-identifier` extension is present. So skipping the off-chain extension when the caller didn't ask never
  affects on-chain tx uniqueness.

To opt in, pass `SignOptions.paymentId` on `prepareInflowPayment`:

```ts
import { createInflowClient } from '@inflowpayai/x402-buyer';
import { generatePaymentId } from '@inflowpayai/x402/extensions';

const core = await createInflowClient({ apiKey, environment: 'sandbox' });
const paymentId = generatePaymentId(); // 'pay_<32 hex>'
const prepared = await core.prepareInflowPayment(requirement, context, { paymentId });
const payment = await prepared.awaitPayload();
```

The SDK validates the format client-side (`validatePaymentId`) and throws `X402PaymentIdFormatError` before any server
round trip if the format is bad. When a valid value is forwarded, the InFlow server treats it as the idempotency key on
the resulting Approval — the caller's value always wins over any server-side default.

For payloads signed by a foundation-registered scheme (the non-InFlow branch of `InflowClient.createPaymentPayload`),
the SDK runs the extension handlers against the seller's declarations after the foundation client returns the payload
and embeds any produced entries into `PaymentPayload.extensions[name]`. The runner lives in `foldInflowExtensions`
(`packages/x402-buyer/src/inflow-client.ts`). The one-shot `createPaymentPayload` API doesn't carry a per-call
`paymentId`, so the default handler returns `null` for `payment-identifier` (no entry) when the seller's declaration is
`required: false`. A declaration marked `required: true` whose handler returns `null` throws — the override never sends
a payload it knows can't satisfy the seller.

## Reading and writing extension entries

Use the typed accessors in `@inflowpayai/x402/extensions`:

```ts
import { getExtension, setExtension, PAYMENT_IDENTIFIER } from '@inflowpayai/x402/extensions';

// Read the declaration from a 402 response body.
const decl = getExtension(paymentRequired.extensions, PAYMENT_IDENTIFIER);
//    ^?  { required: boolean } | undefined

// Override an entry on an extensions map without mutating the input.
const updated = setExtension(extensions, PAYMENT_IDENTIFIER, { required: true });
```

`getExtension` returns `undefined` if the entry is missing or if its shape doesn't match the handler's expected
declaration shape. This keeps `noUncheckedIndexedAccess` strict-clean: no bangs, no inline guards.

## The handler contract

Every extension is a single object satisfying `ExtensionHandler`:

```ts
interface ExtensionHandler<TDeclaration, TPayloadEntry> {
  readonly name: string;
  buildDeclaration(context: DeclarationContext): TDeclaration | null;
  readDeclaration(decl: unknown): TDeclaration | null;
  buildPayloadEntry(declaration: TDeclaration, context: SignContext): TPayloadEntry | null;
}
```

- `buildDeclaration` produces the value that lands in `PaymentRequired.extensions[name]`. The foundation V2 middleware
  emits extension declarations from each route's `RouteConfig.extensions` field, so sellers using this SDK either supply
  that field directly or call `buildDeclaration` from their own pre-route-config code. Returning `null` omits the
  extension from the response entirely.
- `readDeclaration` parses a value the SDK reads from the wire. It must return `null` on any input shape it doesn't
  recognize (never throw).
- `buildPayloadEntry` is called inside `InflowClient.createPaymentPayload` after the foundation-signed branch returns a
  payload, and inside the InFlow signer for the two-phase `prepareInflowPayment` flow (via the underlying `sign` call).
  Returning `null` skips the entry — common when `declaration.required` is `false` and the caller didn't opt in.

The `PAYMENT_IDENTIFIER` handler is the reference implementation:
[packages/x402/src/extensions/payment-identifier.ts](../../packages/x402/src/extensions/payment-identifier.ts).

## Adding a new extension

1. Create a new file under `packages/x402/src/extensions/` (e.g. `webhook-callback.ts`).
2. Define and export the handler.
3. Append the handler to `ALL_EXTENSIONS` in `packages/x402/src/extensions/index.ts`. `EXTENSION_REGISTRY` is built from
   `ALL_EXTENSIONS` automatically.
4. The buyer signer picks it up via `EXTENSION_REGISTRY` with no further wiring; sellers wanting to declare it per route
   can call `handler.buildDeclaration({})` and place the result under their `RouteConfig.extensions[name]` field.

The only assumption the framework makes is that each handler's `name` matches the wire-format extension name (the key in
the `extensions[]` maps). Pick the spec's canonical name.

## Forward compatibility

Server-declared extensions whose `name` doesn't appear in `EXTENSION_REGISTRY` are forwarded with an empty `{}`
declaration on the seller side, and ignored (but tolerated) on the buyer side. This means a server can declare a new
extension before the SDK is updated and nothing breaks — buyers just see the declaration without a handler.

If a server marks an extension `required: true` and the buyer's `InflowClient` has no handler for it in
`EXTENSION_REGISTRY`, the override throws inside `createPaymentPayload`: the foundation-signed branch runs the extension
fold-up loop right before returning the payload, and any required declaration whose handler returns `null` raises an
error. The integrator either upgrades the SDK so a handler ships, or stops trying to pay that resource.

## See also

- [architecture.md](./architecture.md) for how extensions flow through the request lifecycle.
- [protocol-mapping.md](./protocol-mapping.md) for the `PaymentRequired.extensions` / `PaymentPayload.extensions` field
  shape.
