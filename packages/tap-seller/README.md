# @inflowpayai/tap-seller

Framework-neutral merchant verification for Visa Trusted Agent Protocol HTTP message signatures.

The verifier validates the exact method, authority, path, raw query, body digest, signature lifetime, intent tag, and
nonce. Public keys are selected by `keyid` from Visa's documented key service and cached for temporary key-service
outages. Unknown keys and unavailable uncached keys fail verification.

## Install

```bash
pnpm add @inflowpayai/tap-seller
```

## Verify a request

Verification must receive the method, absolute URL, headers, and the exact body bytes observed by the application. Do
not parse and reserialize a request body before verification. Omit `body` when the effective request is bodyless; an
empty byte array represents a request with a body and therefore requires signed `content-digest` and `content-type`
fields. Frameworks that expose only a relative request target must reconstruct the absolute URL from trusted request
metadata before verification.

```ts
import { createTapVerifier } from '@inflowpayai/tap-seller';

const verifier = createTapVerifier();
const facts = await verifier.verify({
  method: request.method,
  url: absoluteRequestUrl,
  headers: request.headers,
  body: requestBodyBytes,
});

if (facts.intent === 'pay') {
  await handlePayment(request);
}
```

Successful verification returns the signing key identifier, Ed25519 algorithm, `browse` or `pay` intent, nonce, creation
and expiration times, and the covered HTTP components. It establishes that a Visa-recognized agent key signed the
supplied request. It does not identify the buyer, authorize application access, or prove payment.

Use `createTapMiddleware` when a function wrapper fits the application:

```ts
import { createTapMiddleware, createTapVerifier } from '@inflowpayai/tap-seller';

const verifyTap = createTapMiddleware(createTapVerifier({ replayStore }));

const response = await verifyTap(
  {
    method: request.method,
    url: absoluteRequestUrl,
    headers: request.headers,
    body: requestBodyBytes,
  },
  async (facts) => routeVerifiedRequest(request, facts),
);
```

`createTapVerifier()` resolves Ed25519 keys from Visa's `https://mcp.visa.com/.well-known/jwks` key set. A deployment
may supply a `VisaTapKeyResolver` with custom fetch, timeout, and cache settings, or a different `TapKeyResolver` that
implements the same `keyid` contract. Keys absent from the configured resolver fail closed with `KEY_NOT_FOUND`.

## Replay and failure handling

`MemoryTapReplayStore` is process-local. Multi-process deployments must provide a `TapReplayStore` whose `claim`
operation is atomic across every merchant instance.

Verification throws `TapVerificationError`. Its `code` distinguishes malformed signature input, invalid or unavailable
keys, invalid signatures and body digests, invalid lifetimes, expired or not-yet-valid signatures, and nonce replay.
Reject the merchant request on every verification error. A cached key may be used during a temporary key-service outage
for at most the resolver's configured maximum cache age; an unavailable uncached key fails closed.

| Code                         | Meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `SIGNATURE_INPUT_INVALID`    | Required signature input is absent, duplicated, or malformed. |
| `SIGNATURE_INVALID`          | The cryptographic signature does not verify.                  |
| `CONTENT_DIGEST_INVALID`     | The supplied body bytes do not match the signed digest.       |
| `SIGNATURE_LIFETIME_INVALID` | The declared validity interval is invalid.                    |
| `SIGNATURE_NOT_YET_VALID`    | The request was received before its validity interval.        |
| `SIGNATURE_EXPIRED`          | The request was received at or after its expiration time.     |
| `KEY_NOT_FOUND`              | The configured resolver has no matching verification key.     |
| `KEY_RETRIEVAL_FAILED`       | No usable cached key exists and key retrieval failed.         |
| `NONCE_REPLAYED`             | The signing key and nonce combination was already claimed.    |

## Request investigation

Successful verification returns structured facts, not a durable investigation record. A merchant that requires later
verification must retain the exact request method and absolute URL, `Signature-Input` and `Signature` fields, signed
`Content-Digest` and `Content-Type` fields when present, and either the exact body bytes or the merchant record whose
bytes produced that digest. Retain the returned verification facts with that record. Protect this material according to
the request's data sensitivity and retention policy; do not place request bodies or signature material in unrestricted
application logs.

## Compose with application protocols

TAP verification is compositional. It does not replace AEP authorization, MPP redemption, x402 verification, or any
merchant application authorization. Verify TAP against the untouched HTTP request, then run the applicable application
and payment checks. An ODP declaration indicates that the Service accepts TAP; it does not verify an individual request.
InFlow issues TAP signatures when the request origin resolves to one published Service that advertises TAP. The Service
does not need an associated InFlow seller account. Alternate request origins must be separately verified for that
Service.

InFlow uses the `agent-browser-auth` tag for discovery and enrollment inspection and the `agent-payer-auth` tag for
payment attempts. The verifier exposes these as `browse` and `pay` respectively.

## License

MIT.
