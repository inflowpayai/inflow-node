# @inflowpayai/mpp

Core types, codec, HTTP client, and shared MPP `Method` definitions for the
[InFlow MPP SDK](https://github.com/inflowpayai/inflow-node/tree/main/docs/mpp).

This package is a transitive dependency of `@inflowpayai/mpp-seller` and `@inflowpayai/mpp-buyer`. Most integrations
don't install it directly.

## Install

```bash
pnpm add @inflowpayai/mpp mppx
```

[`mppx`](https://github.com/wevm/mppx) is a peer dependency. Co-install it on the consumer side so package managers warn
loudly when it's missing.

`MppClient` serves both integration roles. `getConfig`, `validate`, and `broadcast` call Seller-only endpoints and
require a Seller account. `createTransaction`, `getTransaction`, `getPaymentStatus`, and `getSupported` call
authenticated buyer endpoints; any authenticated InFlow account can use them, including a Seller account acting as a
buyer.

## What's exported

- **`inflow`** — the `mppx` `Method` definition for InFlow balance/instrument payments, organised as a namespace that
  defaults to `charge` (`inflow` and `inflow.charge` are the same definition). Also exported: `charge`,
  `inflowChargeRequestSchema`, and `inflowCredentialPayloadSchema`.
- **`tempo`** — the `mppx` `Method` definition for Tempo TIP-20 charges, organised as a namespace that defaults to
  `charge` (`tempo` and `tempo.charge` are the same definition). Also exported: `tempoCharge`,
  `tempoChargeRequestSchema`, and `tempoCredentialPayloadSchema`.
- **`Method` / `z`** — re-exported from `mppx` for method authoring.
- **`cardCharge`** — InFlow's USD/Visa `card/charge` profile, with `cardChargeRequestSchema`,
  `cardCredentialPayloadSchema`, `CardChargeRequest`, and `CardCredentialPayload`. The wire request uses integer cents
  and an embedded RSA public encryption key. Use the seller package's `card(...)` factory to load merchant configuration
  and accept payments. This definition does not implement buyer credential provisioning.
- **`MppClient`** — typed client over the InFlow MPP REST endpoints: `getConfig`, non-mutating `validate`, authoritative
  `broadcast` (seller); `createTransaction`, `getTransaction` (buyer). There is no challenge-minting call — challenges
  are issued locally, not fetched from InFlow. `Idempotency-Key` is supported on `broadcast`. Wraps `InflowHttpClient`
  (API-key / Bearer / anonymous auth, transient-status retry, timeout, `InflowApiError` mapping).
- **Codec** — `encode` / `decode` (base64url-without-padding over RFC 8785 JCS), `encodeCredential`, `decodeCredential`,
  `decodeReceipt`, `canonicalize`, `padBase64Url`, and the `WWW-Authenticate: Payment` `renderChallengeHeader` /
  `parseChallengeHeader` / `parseChallengeHeaders`.
- **Wire types** — `MppChallenge`, `MppCredential`, `MppReceipt`, `MppProblemDetail`, `InflowChallengeRequest`,
  `InflowPaymentOptions`, `TempoChallengeRequest`, `TempoCredentialPayload`, `TempoMethodDetails`, and the REST DTOs
  (`MppConfigResponse`, `MppCredentialRequest`, `MppValidateRequest/Response`, `MppBroadcastRequest/Response`,
  `MppTransactionRequest/Response`).
- **Constants** — `HEADERS`, `CACHE_CONTROL`, `SCHEME_PAYMENT`, `METHOD_INFLOW`, `INTENT_CHARGE`, `PROBLEM_TYPE_BASE`,
  `PROBLEM_TYPES`, `ENDPOINTS`, `MPP_PROTOCOL_VERSION`, `MPP_SDK_VERSION`, plus `readHeader` / `readHeaderAll` /
  `transactionPath`.
- **Errors** — `InflowApiError`, `MppCodecError`, `MppProtocolVersionError`.

## Example

API redirects are returned as `InflowApiError` responses; credentials and request bodies are not forwarded to redirect
destinations. Caller cancellation stops the request and retry waits, reported as `NETWORK_ERROR`.

`createTransaction` and `authorizeSubscription` default to zero retries because another attempt can create another
approval or authorization. Callers can explicitly set `retries`, but must account for an earlier request that may have
succeeded before its response was lost. Read operations retain transient-error retries.

```ts
import { MppClient, parseChallengeHeaders } from '@inflowpayai/mpp';

const apiKey = process.env['INFLOW_API_KEY'];
if (!apiKey) throw new Error('Set INFLOW_API_KEY.');
const mpp = new MppClient({ apiKey, environment: 'sandbox' });

const response = await fetch('http://localhost:3000/api/report', { redirect: 'manual' });
if (response.status !== 402) throw new Error('Expected a payment challenge.');
const challenge = parseChallengeHeaders([response.headers.get('www-authenticate') ?? '']).find(
  (candidate) => candidate.method === 'inflow' && candidate.intent === 'charge',
);
if (!challenge) throw new Error('The seller did not offer an InFlow charge.');

const instrumentId = process.env['INSTRUMENT_ID'];
const tx = await mpp.createTransaction({
  challenge,
  options: instrumentId ? { instrumentId } : {},
});
console.log({ transactionId: tx.transactionId, state: tx.state });
```

This starts a purchase against the [USD seller example](../../examples/mpp-seller-express#usd-linked-card-example). For
another seller, check the advertised price, currency and payment method before calling `createTransaction`. The
challenge determines the rail. On the Instrument rail, omitting `instrumentId` uses the buyer's primary card; an
unavailable selection fails without choosing another card.

Retain the returned transaction ID. When `state` is `pending`, wait for InFlow approval and read that same transaction
with `getTransaction`, respecting `retryAfterSeconds` and a bounded wait. A `failed` or `expired` result stops the
purchase. When `ready`, save the credential securely and retry the original seller request with
`Authorization: Payment <credential>`, without following redirects. Credential readiness is not settlement success. The
[buyer package](../mpp-buyer) provides approval polling for applications that do not need to manage it themselves.

See the [MPP product docs](https://github.com/inflowpayai/inflow-node/tree/main/docs/mpp) for the buyer/seller
integration shape and the PSP architecture.

## Card verification and payment status

An MPP credential marked `ready` authorizes a request; it does not prove that the seller has received payment. After the
seller reports settlement is pending, call `getPaymentStatus` with the original InFlow transaction ID. If the bank
requires card verification, `nextAction` supplies a dashboard URL for the buyer. The buyer signs in there and follows
the bank's instructions. The SDK does not receive a Stripe client secret or open a browser.

```ts
import { MppClient } from '@inflowpayai/mpp';

const apiKey = process.env['INFLOW_API_KEY'];
const transactionId = process.env['TRANSACTION_ID'];
if (!apiKey || !transactionId) throw new Error('Set INFLOW_API_KEY and the original TRANSACTION_ID.');
const client = new MppClient({ apiKey, environment: 'sandbox' });
const payment = await client.getPaymentStatus(transactionId);
if (payment.nextAction?.type === 'authenticate_card') {
  console.log('Verify this payment:', payment.nextAction.url);
}
```

Each call performs one read by default; it does not poll automatically. Pass request options such as `signal`,
`timeoutMs`, or `retries` when needed. Stopping a read does not cancel the payment. No `nextAction` means only that
there is no available buyer action, not that payment succeeded. For an Instrument purchase, wait for `SETTLED`, then
retry the original seller request with the same saved credential and obtain its receipt. Do not create another
transaction or change the selected card. Retain the original credential for resumption; `getPaymentStatus` does not
return one. If you retained only the transaction ID, `getTransaction(transactionId)` returns the stored credential for a
settled Instrument charge. Its expiry remains unchanged: recovery lets the seller obtain the original receipt, not
authorize another charge. This retrieval is restricted to the original buyer. Balance payments and subscriptions have
different recovery rules; do not infer the same behavior for them. HTTP or network errors leave the payment outcome
unknown.

## License

MIT.
