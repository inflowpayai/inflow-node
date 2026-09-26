# InFlow shared conformance

The runtime adapter calls the public `InflowHttpClient` and `resolveBaseUrl` exports from both `@inflowpayai/mpp` and
`@inflowpayai/x402`. It uses the shared runner and scripted HTTP platform in
[inflow-specs](https://github.com/inflowpayai/inflow-specs), pinned by `inflow-specs.lock.json`. This is development
tooling, not a dependency of the published SDKs.

Prepare a separate, clean checkout of inflow-specs at the revision in the lock file and run
`pnpm install --frozen-lockfile` there. In this repository, run:

```sh
pnpm runtime:conformance --contract-root ../inflow-specs --output /tmp/inflow-runtime-report.json
```

The command builds the tested packages, checks the contract revision, then writes a report to a new file. It refuses to
overwrite an existing report. The report includes source commits, dirty states, input hashes, package versions, and each
case outcome. It records installed `mppx` and `@x402/core` versions from the corresponding package's `node_modules`, not
the dependency ranges in its manifest. A failed or interrupted run does not count as passing. The contract checkout must
be clean; the SDK report identifies local edits.

The shared fixtures define authentication/account-role responses and approval read/cancel exchanges. `runtime-cases.mjs`
adapts those fixtures and adds Node transport checks for environment selection, JSON/text/empty responses, error
preservation, header redaction, retry budgets, token rotation, request timeout and caller cancellation. Requests use
only the loopback test platform. Environment defaults are inspected without contacting production or sandbox.

Approval cases execute prescribed reads and cancellation requests through the HTTP client. They do not implement a
poller or prove payment completion. Buyer payment polling, credential readiness, and settlement belong to the MPP/x402
Buyer and Seller suites. The runtime report does not certify live authentication, cryptographic verification, blockchain
settlement, or redirect handling.

## MPP Core, Buyer, and Seller

```sh
pnpm mpp:conformance:shared --contract-root ../inflow-specs --output /tmp/inflow-mpp-report.json
```

This selects every `mpp-core`, `mpp-buyer`, and `mpp-seller` case from the pinned contract. The adapter calls the public
codecs and Buyer `inflow`, `inflow.subscription`, and `tempo` methods. The SDK performs transaction creation, polling,
subscription authorization, timeout handling, and approval cancellation. The adapter does not reproduce those workflows.

Cancellation cases observe a pending response through the public fetch option, then call the method's `cleanup()`. The
original response is passed through unchanged. The shared runner waits for the SDK's asynchronous cancellation request
before marking the case passed. Known SDK error classes map to the contract's test-only classifications; unknown errors
fail the adapter. Problems, transaction identifiers, credential payloads, and sources are preserved.

Seller cases call public request preparation, validation, and verification methods. Verification uses the foundation's
validate-then-broadcast composition, not adapter-written sequencing. Route-binding cases issue a real framework
challenge, serialize a synthetic credential, and submit it to a handler configured with different payment terms. The
handler must reject it before platform validation or broadcast. Idempotency cases inspect SDK-generated keys and require
retries to reuse the original key; the adapter does not inject a key.

The report records all three SDK package versions and their installed `mppx` version. It does not certify live
authentication, signing, settlement, or platform replay enforcement. Only synthetic credentials and the local scripted
platform are used.

`pnpm mpp:conformance` remains the separate upstream MPP protocol-vector command. It does not run these InFlow payment
workflows. Neither conformance runner is a dependency of the published SDKs.
