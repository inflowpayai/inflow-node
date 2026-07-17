# Example — AEP plus MPP seller on Express

This Express Service applies Agent Enrollment Protocol (AEP) authentication before Machine Payments Protocol (MPP)
payment enforcement. Its API-key credential uses `x-aep-api-key`, leaving `Authorization: Payment` available for the MPP
credential.

## Run

Start the local AEP Platform example first. It serves the Service DID used by this example.

```bash
cd /Users/nxkavian/Drive/Source/AEP/aep-node
pnpm --filter @aep-foundation/example-aep-platform-ephemeral start
```

Build the AEP packages, then use the existing unified local-link script in the InFlow command-line interface checkout
when exercising the command-line scenarios below. It links the local AEP SDK packages without adding an example-specific
linker.

```bash
cd /Users/nxkavian/Drive/Source/AEP/aep-node
pnpm --filter @aep-foundation/core build
pnpm --filter @aep-foundation/service build
pnpm --filter @aep-foundation/express build

cd /Users/nxkavian/Drive/Source/InFlow/inflow-cli
node scripts/link-local-inflow-node.mjs
```

Configure and start this example:

```bash
cd /Users/nxkavian/Drive/Source/InFlow/inflow-node/examples/mpp-aep-seller-express
cp .env.example .env
# Set INFLOW_API_KEY, INFLOW_BASE_URL, and MPP_SECRET_KEY.
pnpm install
pnpm start
```

`SERVICE_DID` defaults in `.env.example` to the local Platform example's Service DID. `HOST` and `PORT` default to
`127.0.0.1` and `3000`. `INFLOW_BASE_URL` selects the InFlow environment that issued `INFLOW_API_KEY` and defaults in
`.env.example` to `https://sandbox.inflowpay.ai`.

## Routes

| Route                                                 | Enforcement                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/widgets`                                    | AEP API key, then 0.01 USDC MPP charge                          |
| `POST /api/upload`                                    | AEP API key, then 0.10 USDC MPP charge; echoes the request body |
| `GET /free`                                           | No AEP or MPP enforcement                                       |
| `GET /.well-known/aep`, `/aep/*`, `GET /openapi.json` | AEP discovery, lifecycle, and OpenAPI documents                 |

For a protected route, an anonymous request receives only the AEP `401` challenge. A request with `x-aep-api-key` but no
payment receives only the MPP `402` challenge. A completed payment replay carries both `x-aep-api-key` and
`Authorization: Payment …`.

## Command-line scenarios

Use the built command-line interface from `/Users/nxkavian/Drive/Source/InFlow/inflow-cli` with the local Platform and
this Service running:

```bash
node packages/cli/dist/cli.js inspect http://127.0.0.1:3000/api/widgets --format json
node packages/cli/dist/cli.js aep inspect http://127.0.0.1:3000 --format json
node packages/cli/dist/cli.js aep fetch http://127.0.0.1:3000/api/widgets --format json
node packages/cli/dist/cli.js aep grant http://127.0.0.1:3000 --grant-type api-key --format json
node packages/cli/dist/cli.js aep fetch http://127.0.0.1:3000/api/widgets --format json
node packages/cli/dist/cli.js mpp pay http://127.0.0.1:3000/api/widgets --format json
node packages/cli/dist/cli.js mpp pay http://127.0.0.1:3000/api/upload --method POST --data '{"widget":"one"}' --header 'X-Caller-Header: retained' --format json
```

The first `aep fetch` uses the API-key Grant path and stops with the downstream payment-required result. Re-running it
after explicit Grant reuses the stored key. `mpp pay` performs AEP authentication before payment creation; the returned
payment identifier can be completed with `mpp fetch` when approval is asynchronous.
