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
    "payment-identifier": {
      "info": { "required": false },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "id": { "type": "string", "minLength": 16, "maxLength": 128 },
          "required": { "type": "boolean" },
        },
        "required": ["required"],
      },
    },
  },
}
```

Today the seller always declares `required: false`. A future server revision may set `required: true` to require the
buyer to embed an ID.

**Payload entry** (in `PaymentPayload.extensions`):

```jsonc
{
  "extensions": {
    "payment-identifier": {
      "info": {
        "id": "pay_abc1234567890_xyz",
        "required": false,
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "id": { "type": "string", "minLength": 16, "maxLength": 128 },
          "required": { "type": "boolean" },
        },
        "required": ["required"],
      },
    },
  },
}
```

The default ID format is `pay_<32 hex chars>` (36 chars total), but any string satisfying the regex + length rules is
valid.

### Identifier generation

The InFlow facilitator adapter preserves a valid identifier supplied by the buyer. When the payload has no valid
identifier, the adapter derives one from payment-specific wire material. The same payload therefore carries the same
identifier through verification, settlement, and settlement retries without retaining process-local state.

The declaration remains optional (`required: false`). Automatic generation improves idempotency when an InFlow
facilitator is used; it does not require buyers to understand or provide the extension.

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
the SDK runs the extension handlers against the seller's declarations after the foundation client returns a payload. The
one-shot API has no caller-supplied `paymentId`, so an optional declaration does not add an entry at that point. An
InFlow facilitator derives and adds a stable identifier before forwarding the payload to its verify or settle endpoint.
A declaration marked `required: true` cannot be satisfied without a caller-supplied identifier and throws before the
buyer sends the payload.

## EIP-2612 gas sponsorship

`inflowRoute` in `@inflowpayai/x402-seller` declares sponsorship for compatible Permit2 offers using the foundation
`@x402/extensions` declaration. The external buyer's `@x402/evm/exact/client` scheme signs the token permit when
allowance is insufficient. This extension does not use InFlow's handler registry. With sufficient allowance, the
foundation can echo the unsigned declaration into the payment payload without creating a permit.

See the [seller guide](../../packages/x402-seller/README.md#gasless-permit2-approval-for-external-wallets) for token
capability checks, facilitator ordering, and setup. InFlow-managed buyers cannot sign Permit2 payments. Generic ERC-20
raw-transaction approval batching is not declared.

## InFlow EIP-7702 sponsorship

`inflowEip7702GasSponsoring` is an opt-in custom extension for external-wallet Permit2 payments. Its route declaration
is `{ info: { version: '1' } }`. A signed entry contains `info.version`, `info.sponsorshipId`, the owner's personal-sign
`info.signature`, and an optional `info.authorizationSignature` for delegation. An unchanged declaration is not a signed
sponsorship.

The asynchronous foundation `ClientExtension` lives at `@inflowpayai/x402-buyer/eip7702`, outside InFlow's synchronous
handler registry. It reuses the selected Permit2 payment and the configured InFlow preparation endpoint, not a URL from
the merchant. See the [buyer guide](../../packages/x402-buyer/README.md#eip-7702-sponsorship-for-external-wallets) for
signing, consent, dependency requirements and persistent-delegation risks. The standard EIP-2612 and managed-buyer paths
are independent.

## Reading and writing extension entries

Use the typed accessors in `@inflowpayai/x402/extensions`:

```ts
import { getExtension, setExtension, PAYMENT_IDENTIFIER } from '@inflowpayai/x402/extensions';

// Read the declaration from a 402 response body.
const decl = getExtension(paymentRequired.extensions, PAYMENT_IDENTIFIER);
//    ^?  PaymentIdentifierDeclaration | undefined

// Override an entry on an extensions map without mutating the input.
const declaration = PAYMENT_IDENTIFIER.buildDeclaration({});
const requiredDeclaration = { ...declaration, info: { required: true } };
const updated = setExtension(extensions, PAYMENT_IDENTIFIER, requiredDeclaration);
```

`getExtension` returns `undefined` if the entry is missing or if its shape doesn't match the handler's expected
declaration shape. This keeps `noUncheckedIndexedAccess` strict-clean: no bangs, no inline guards.

## The handler contract

InFlow-owned extension handlers satisfy `ExtensionHandler`; foundation-owned extensions use their foundation APIs:

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
  Returning `null` skips the entry — common when the declaration is optional and the caller didn't opt in.

The `PAYMENT_IDENTIFIER` handler is the reference implementation:
[packages/x402/src/extensions/payment-identifier.ts](../../packages/x402/src/extensions/payment-identifier.ts).

## Adding an InFlow-owned extension

1. Create a new file under `packages/x402/src/extensions/` (e.g. `webhook-callback.ts`).
2. Define and export the handler.
3. Append the handler to `ALL_EXTENSIONS` in `packages/x402/src/extensions/index.ts`. `EXTENSION_REGISTRY` is built from
   `ALL_EXTENSIONS` automatically.
4. The buyer signer picks it up via `EXTENSION_REGISTRY` with no further wiring; sellers wanting to declare it per route
   can call `handler.buildDeclaration({})` and place the result under their `RouteConfig.extensions[name]` field.

The only assumption the framework makes is that each handler's `name` matches the wire-format extension name (the key in
the `extensions[]` maps). Pick the spec's canonical name.

## Forward compatibility

The foundation preserves route declarations that no registered extension enriches. On the foundation-signed buyer path,
`InflowClient` folds only handlers registered in `EXTENSION_REGISTRY`; other entries remain as returned by the
foundation. Preserving an entry does not establish that the buyer or facilitator supports its semantics.

A recognized declaration marked `required: true` throws when its InFlow handler produces no payload entry. Unknown
extensions do not reach this check, even if marked required; integrators must validate support for required extensions.

## See also

- [architecture.md](./architecture.md) for how extensions flow through the request lifecycle.
- [protocol-mapping.md](./protocol-mapping.md) for the `PaymentRequired.extensions` / `PaymentPayload.extensions` field
  shape.
