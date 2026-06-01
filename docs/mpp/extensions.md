# Extensions — the `charge` → `session` namespace path

The `inflow` method ships with the `charge` intent only. It is structured as an `mppx` `Method` **namespace** so a
second intent — `session` — can be added later without changing the `inflow` import surface.

## Today

`@inflowpayai/mpp` exports `charge` (the `Method.from` definition) and `inflow`, a namespace that defaults to `charge`
and exposes it as `inflow.charge`:

```ts
import { inflow } from '@inflowpayai/mpp';

inflow; // the charge definition (the default)
inflow.charge; // the same definition, named
```

InFlow recognises the method and intent additively, so a new intent is additive on both sides: a sibling `Method` in the
SDK, and InFlow accepting the new intent label on the wire.

## Adding `session` later

`session` slots in as a sibling definition plus its client/server behaviour, with no breaking change to consumers:

1. **Core** — add a sibling definition and attach it to the namespace:

   ```ts
   export const session = Method.from({
     intent: 'session',
     name: 'inflow',
     schema: { request: inflowSessionRequestSchema, credential: { payload: inflowCredentialPayloadSchema } },
   });

   export const inflow = Object.assign(charge, { charge, session });
   ```

   Consumers keep writing `inflow` (charge) and `inflow.charge`; `inflow.session` becomes available additively.

2. **Seller** (`@inflowpayai/mpp-seller`) — add the `Method.toServer` behaviour for `session`. It issues the `session`
   challenge locally, the same way `charge` does (no server round-trip to mint it), and its `verify` calls
   `POST /v1/mpp/redeem`, exactly as `charge` does.

3. **Buyer** (`@inflowpayai/mpp-buyer`) — add the `Method.toClient` behaviour for `session`; it reuses the same
   `POST /v1/transactions/mpp` → poll → credential lifecycle.

Because InFlow is the PSP (see [architecture.md](./architecture.md)), neither side hard-codes intent-specific signing or
binding — both intents delegate to the same InFlow endpoints — so the marginal cost of a new intent is a schema, the two
thin `toClient`/`toServer` hooks, and InFlow accepting the new intent label.
