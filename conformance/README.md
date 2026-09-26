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

## x402 Core, Buyer, and Seller

```sh
pnpm x402:conformance:shared --contract-root ../inflow-specs --output /tmp/inflow-x402-report.json
```

This selects every `x402-core`, `x402-buyer`, and `x402-seller` case from the pinned contract. Identifier cases call the
public extension helpers. Buyer cases call `createInflowClient`, `prepareInflowPayment`, and the returned handle's
`awaitPayload` or `cancel`. The SDK owns capability checks, creation, polling, timeout handling, and cancellation. Two
concurrent waits must return the same complete result while making only one polling request.

The two-phase handle stays under caller control: failure cases do not add automatic cancellation. Explicit cancellation
cases await the cancellation request and then observe the handle's rejection, including when the platform rejects
cancellation. Known SDK error types retain transaction statuses and complete API error bodies; unknown exceptions fail
the adapter. Caller-owned input is checked for mutation on success and recognized failure.

Seller cases call the public authenticated or anonymous facilitator client. The SDK supplies missing payment identifiers
and handles pending-settlement retries. The adapter does not insert identifiers or retry requests. `verify-settle` calls
settlement only after successful verification; this checks composition of the two public operations, not a framework's
protection of a request handler.

Offer and route cases pass fixture configuration through the public Seller client interface to `inflowAccepts` and
`inflowRoute`. The SDK constructs prices, filters offers, and decides which sponsorship declarations to include. These
cases do not exercise configuration fetching or caching. Caller-owned input remains checked on both success and
recognized failure.

The report records all three SDK package versions and their installed `@x402/core` and `@x402/extensions` versions.
These synthetic platform responses do not certify live signing, settlement, external-wallet execution, foundation
middleware, or sponsorship execution.

## Hosted reports and contract drift

The **shared conformance** workflow runs on pull requests, pushes to `main`, and manual dispatch. Each Node 22/24 and
locked/latest foundation combination runs all three suites against both the pinned contract and the current
`inflow-specs` main commit. A failure in one suite does not prevent the other suites from producing reports; any failure
still fails the job. The current-contract step runs even if the pinned cases fail.

Open the workflow run's **Artifacts** section and download `conformance-node22-locked`, `conformance-node22-latest`,
`conformance-node24-locked`, or `conformance-node24-latest`. Each artifact contains `pinned-*.json` and `current-*.json`
reports for runtime, MPP, and x402, retained for 14 days. Failed runs also upload available reports. Check `completed`
and `passed`; an empty or incomplete report is not passing evidence. Installation/build failures may prevent reports.

The contract runner uses Node 24; `--adapter-node` selects the executable that runs the SDK adapter. Reported
`implementation.runtime` is that adapter's actual Node version. The latest-dependency jobs intentionally modify
dependency manifests and the lockfile; their SDK dirty state records that fact.

For a local drift check, explicitly select the full commit of a clean contract checkout:

```sh
node scripts/conformance.mjs --suite x402 \
  --contract-root ../inflow-specs --contract-revision FULL_COMMIT_SHA \
  --adapter-node /absolute/path/to/node --output /tmp/inflow-current-x402.json
```

Without `--contract-revision`, the lock file remains authoritative. An explicit revision does not permit a dirty
contract checkout. Reports record the actual contract commit and input hashes; the drift check does not update the pin
or change the contract to match the implementation. These workflows use synthetic credentials and local mock services,
not live accounts or payments.
