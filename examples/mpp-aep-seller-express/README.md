# Example — AEP plus MPP seller on Express

This Express Service applies Agent Enrollment Protocol (AEP) authentication before Machine Payments Protocol (MPP)
payment enforcement. Its API-key credential uses `x-aep-api-key`, leaving `Authorization: Payment` available for the MPP
credential.

## Prerequisite

This example requires an InFlow **Seller** account and an API key created in its dashboard:

- [Sandbox registration](https://sandbox.inflowpay.ai) for testing
- [Production registration](https://app.inflowpay.ai) for live payments

A Developer account is a different API role and cannot be used in place of a Seller account for this example.

## Run

Start the local AEP Platform example first. It provisions and signs for the Agent identities used by this example.

```bash
cd aep-node
pnpm install
pnpm build
pnpm --filter @aep-foundation/example-aep-platform-ephemeral start
```

Configure and start this example:

```bash
cd inflow-node/examples/mpp-aep-seller-express
cp .env.example .env
# Set INFLOW_API_KEY, INFLOW_BASE_URL, and MPP_SECRET_KEY.
pnpm install
pnpm start
```

The Service derives its `did:web` identifier from its public `HOST` and `PORT` and publishes the corresponding DID
document itself. `HOST` and `PORT` default to `127.0.0.1` and `3000`. `INFLOW_BASE_URL` selects the InFlow environment
that issued `INFLOW_API_KEY` and defaults in `.env.example` to `https://sandbox.inflowpay.ai`.

## Routes

| Route                                               | Enforcement                                                     |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/widgets`                                  | AEP API key, then 0.01 USDC MPP charge                          |
| `POST /api/upload`                                  | AEP API key, then 0.10 USDC MPP charge; echoes the request body |
| `GET /api/subscribe`                                | AEP API key, then 1.00 USDC monthly MPP subscription            |
| `GET /free`                                         | No AEP or MPP enforcement                                       |
| `GET /.well-known/aep`, `GET /.well-known/did.json` | AEP discovery and the origin-bound Service DID document         |
| `/aep/*`, `GET /openapi.json`                       | AEP lifecycle and OpenAPI documents                             |

For a protected route, an anonymous request receives only the AEP `401` challenge. A request with `x-aep-api-key` but no
payment receives only the MPP `402` challenge. A completed payment replay carries both `x-aep-api-key` and
`Authorization: Payment …`.

## Command-line scenarios

Use the InFlow command-line interface with the local Platform and this Service running:

```bash
inflow inspect http://127.0.0.1:3000/api/widgets --format json
inflow aep inspect http://127.0.0.1:3000 --format json
inflow aep fetch http://127.0.0.1:3000/api/widgets --format json
inflow aep grant http://127.0.0.1:3000 --grant-type api-key --format json
inflow aep fetch http://127.0.0.1:3000/api/widgets --format json
inflow mpp pay http://127.0.0.1:3000/api/widgets --format json
inflow mpp pay http://127.0.0.1:3000/api/upload --method POST --data '{"widget":"one"}' --header 'X-Caller-Header: retained' --format json
inflow mpp subscribe http://127.0.0.1:3000/api/subscribe --format json
```

The first `aep fetch` uses the API-key Grant path and stops with the downstream payment-required result. Re-running it
after explicit Grant reuses the stored key. `mpp pay` performs AEP authentication before payment creation; the returned
payment identifier can be completed with `mpp fetch` when approval is asynchronous.
