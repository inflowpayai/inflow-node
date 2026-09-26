# InFlow runtime conformance

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
