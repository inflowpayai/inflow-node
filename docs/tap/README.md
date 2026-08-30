# InFlow Trusted Agent Protocol Profile

This directory contains language-neutral conformance vectors for the InFlow Visa Trusted Agent Protocol profile. The
profile uses HTTP Message Signatures from RFC 9421 and content digests from RFC 9530 over exact transmitted body bytes.

`request-signing-vectors.json` is normative for InFlow implementations. It contains a test-only Ed25519 key, four
positive vectors, and negative cases that name the required verifier result. The private seed must never be used outside
tests.

## Request profile

Every signature covers `@method`, `@authority`, `@path`, and `@query`. Requests with bodies also cover `content-digest`
and `content-type`; the digest is computed over the exact transmitted bytes. Signature input uses the `sig2` label,
lowercase `alg="ed25519"`, a fresh nonce, and a validity interval no longer than eight minutes. InFlow-issued signatures
use five minutes and verifiers require `created <= now < expires`. Visa's prose examples use `alg="Ed25519"`, so a
verifier accepts exactly that spelling and the RFC-registered lowercase spelling, preserves the received value in the
signature base, and rejects every other algorithm value.

The `agent-browser-auth` tag identifies discovery and enrollment inspection. The `agent-payer-auth` tag identifies MPP
and x402 payment attempts. These tags describe the agent interaction; payment and application authorization remain
independent checks.

Redirects are signed as separate requests. A signature is never forwarded to a different effective request. The
underlying ODP, AEP, MPP, or x402 transport decides whether a redirect is allowed and applies its method and body rules.
For an accepted redirect, TAP removes prior signature and disallowed credential material and signs the resulting request
with a fresh nonce. TAP does not independently reject a redirect that the underlying protocol permits.

Merchants select the public key using the signature's `keyid`. Unknown keys, unavailable uncached keys, invalid
signatures, invalid digests, expired signatures, and repeated nonces fail closed. Key registration controls whether
Visa's key set can resolve an InFlow production or sandbox `keyid`; it does not change the wire profile or local
conformance behavior.

## Merchant integration

Use `@inflowpayai/tap-seller` to verify the untouched method, absolute URL, headers, and body bytes locally. A
multi-process merchant deployment must provide an atomic shared replay store. Continue into AEP, MPP, x402, and
application authorization only after TAP verification succeeds; TAP does not replace any of those checks. See the
[seller package guide](../../packages/tap-seller/README.md) for the public API and integration example.

InFlow signs requests whose origin resolves to one published Service advertising TAP. A Service does not need an
associated InFlow seller account. Its canonical origin is attributable to the published Service; alternate origins
require separate verification.

An implementation consuming the vectors must:

1. Reconstruct each positive vector's `signatureBase` from `request`, `coveredComponents`, and `signatureParameters`.
2. Verify the stored signature with `testKey.publicKeyHex`.
3. Generate the same deterministic Ed25519 signature from `testKey.privateSeedHex` when it implements signing.
4. Recompute every body digest from `bodyBase64`.
5. Apply each negative mutation described in `negative-vectors.json` and return its `expectedError`.

Time-validation vectors use fixed Unix timestamps. A verifier test supplies its clock explicitly; it does not compare
them with wall-clock time.

Mutation keys containing dots replace that exact nested field. `removeCoveredComponent` removes one component from the
source vector before validation. `precondition.verifiedNonce` seeds the replay store. Mutations retain the source
signature.

Run `pnpm tap:conformance` to validate the vector structure, reconstruct every signature base, verify every positive
signature and body digest, and confirm the required failure for every negative case. `pnpm conformance` runs both the
MPP and TAP suites. The TAP suite also runs through `pnpm verify` and the repository continuous-integration workflow.

## Authoritative sources

- [Visa Trusted Agent Protocol specifications](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications/)
- [RFC 9421: HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
- [RFC 9530: Digest Fields](https://www.rfc-editor.org/rfc/rfc9530.html)
