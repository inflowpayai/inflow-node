# @inflowpayai/mpp

Core types, codec, HTTP client, and the shared `inflow` `Method` definition for the
[InFlow MPP SDK](https://github.com/inflowpayai/inflow-node/tree/main/docs/mpp).

This package is a transitive dependency of `@inflowpayai/mpp-seller` and `@inflowpayai/mpp-buyer`. Most integrations
don't install it directly.

## Install

```bash
pnpm add @inflowpayai/mpp mppx
```

[`mppx`](https://github.com/wevm/mppx) is a peer dependency. Co-install it on the consumer side so package managers warn
loudly when it's missing.

## What's exported

- **`inflow`** — the `mppx` `Method` definition for InFlow's `inflow` method, organised as a namespace that defaults to
  `charge` (`inflow` and `inflow.charge` are the same definition today). The buyer/seller packages attach
  `Method.toClient` / `Method.toServer` behaviour. Also exported: `charge`, `inflowChargeRequestSchema`,
  `inflowCredentialPayloadSchema`, and `Method` / `z` (re-exported from `mppx` for authoring sibling intents).
- **`MppClient`** — typed client over the InFlow MPP REST endpoints: `getConfig`, `redeem` (seller);
  `createTransaction`, `getTransaction` (buyer). There is no challenge-minting call — challenges are issued locally, not
  fetched from InFlow. `Idempotency-Key` is supported on the mutating routes. Wraps `InflowHttpClient` (API-key / Bearer
  / anonymous auth, transient-status retry, timeout, `InflowApiError` mapping).
- **Codec** — `encode` / `decode` (base64url-without-padding over RFC 8785 JCS), `encodeCredential`, `decodeCredential`,
  `decodeReceipt`, `canonicalize`, `padBase64Url`, and the `WWW-Authenticate: Payment` `renderChallengeHeader` /
  `parseChallengeHeader` / `parseChallengeHeaders`.
- **Wire types** — `MppChallenge`, `MppCredential`, `MppReceipt`, `MppProblemDetail`, `InflowChallengeRequest`,
  `InflowPaymentOptions`, and the REST DTOs (`MppConfigResponse`, `MppRedeemRequest/Response`,
  `MppTransactionRequest/Response`).
- **Constants** — `HEADERS`, `CACHE_CONTROL`, `SCHEME_PAYMENT`, `METHOD_INFLOW`, `INTENT_CHARGE`, `PROBLEM_TYPE_BASE`,
  `PROBLEM_TYPES`, `ENDPOINTS`, `MPP_PROTOCOL_VERSION`, `MPP_SDK_VERSION`, plus `readHeader` / `readHeaderAll` /
  `transactionPath`.
- **Errors** — `InflowApiError`, `MppCodecError`, `MppProtocolVersionError`.

## Example

```ts
import { MppClient, parseChallengeHeaders } from '@inflowpayai/mpp';

const mpp = new MppClient({ apiKey: process.env.INFLOW_API_KEY!, environment: 'sandbox' });

// Buyer: parse a 402's challenges and fulfil one through the InFlow buyer endpoint.
const [challenge] = parseChallengeHeaders(['Payment id="…", realm="…", method="inflow", intent="charge", request="…"']);
const tx = await mpp.createTransaction({ challenge });
if (tx.state === 'ready' && tx.credential) {
  // send `Authorization: Payment ${tx.credential}` on the retried request
}
// The rail is read from the challenge — the buyer doesn't choose it. For an instrument-rail (fiat)
// challenge, supply the funding instrument: mpp.createTransaction({ challenge, options: { instrumentId } }).
```

See the [MPP product docs](https://github.com/inflowpayai/inflow-node/tree/main/docs/mpp) for the buyer/seller
integration shape and the PSP architecture.

## License

MIT.
