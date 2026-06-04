# Advanced: Dual-Advertising x402 and MPP on One Endpoint

> **Status: custom / unsupported.** This document describes a bespoke integration you build and maintain yourself.
> Neither `@inflowpayai/*` nor the underlying `@x402/*` / `mppx` SDKs ship a combinator for it. For a normal
> integration, **pick one protocol** and use the seller quickstart — you do not need this.
>
> Read this only if you specifically want a _single_ resource to offer both x402 and MPP payment options and let the
> buyer (typically an agent) choose which to use.

---

## 1. The question

A standard InFlow seller commits to one protocol. The advanced question is: can a single endpoint emit a `402` that
advertises **both** an x402 challenge and an MPP challenge, accept payment via **either**, and settle correctly —
without the two protocols stepping on each other?

**Answer: yes, technically — as a custom endpoint.** The two protocols are header-disjoint, and both SDKs expose the
primitives needed to build a challenge and to verify a payment _outside_ their all-in-one middleware. What they don't
give you is a single call that does it; you wire the two halves together and own correctness.

---

## 2. Recommendation (read this first)

For almost every seller, **choose x402 or MPP and build on one.** It's less code, fully supported, and what the SDKs are
designed around. The decision logic is simple:

- **You want one protocol.** Pick the one that matches how your buyers pay (see the comparison in the seller reference
  guide) and stop here — you never touch this document.
- **You truly need both on the same resource** — e.g. to maximize the set of agent buyers that can transact with you
  without negotiating a protocol first. Only then is the dual-advertise design below worth it.

If you're in the second case, go in with eyes open: this is a bespoke endpoint, not a config flag. You take on the
parity, lifecycle, and maintenance work detailed in [§7](#7-what-you-own-the-real-cost). The good news is that
delegating the x402 half to `x402HTTPResourceServer` (see §5–§6) keeps most of it on supported code, and the reusable
wrapper in §6 means you write the hard part once and apply it to many routes.

Everything from §3 onward assumes you've decided the dual path is right for you.

---

## 3. Why there's no header collision

The protocols use completely separate HTTP headers at every step, so both challenges can live on one `402` response and
both reply paths are unambiguous:

| Step               | x402                                    | MPP                                                  |
| ------------------ | --------------------------------------- | ---------------------------------------------------- |
| `402` challenge    | `PAYMENT-REQUIRED` header (base64 JSON) | `WWW-Authenticate: Payment …` header(s)              |
| Buyer's paid retry | `PAYMENT-SIGNATURE` request header      | `Authorization: Payment <credential>` request header |
| Success receipt    | `PAYMENT-RESPONSE` response header      | `Payment-Receipt` response header                    |

Both use HTTP status `402`. Nothing overlaps. The only thing that "conflicts" in a naive setup is **response
ownership**: each SDK's middleware builds and _sends_ the entire `402` and ends the request, so you cannot simply stack
`paymentMiddlewareFromConfig` and `mppx.charge(...)` on the same route. The fix is to not use either middleware on that
route — build the response yourself from the lower-level primitives below.

---

## 4. The primitives that make it possible

These exist in the installed SDKs (verified against `@x402/core@2.12.0` and `mppx@0.6.28`).

### x402 (`@inflowpayai/x402-seller` + `@x402/core`)

- `createInflowFacilitator({ environment, apiKey })` → a `FacilitatorClient` exposing `verify(payload, requirements)`
  and `settle(payload, requirements)` you can call directly.
- `createInflowSellerClient(...)` + `inflowAccepts(seller, { price })` → the `PaymentOption[]` for the route (same call
  a normal seller uses).
- From `@x402/core/http`:
  - `encodePaymentRequiredHeader(paymentRequired)` → the `PAYMENT-REQUIRED` header value.
  - `decodePaymentSignatureHeader(value)` → the buyer's `PaymentPayload`.
  - `encodePaymentResponseHeader(settleResponse)` → the success `PAYMENT-RESPONSE` header value.
- Higher-level alternative: `x402HTTPResourceServer` (the framework-agnostic core the Express adapter wraps) with
  `processHTTPRequest(ctx)` and `processSettlement(payload, requirements)`. This resolves payment options into on-wire
  requirements and produces the `402` for you — see §6.

Key shape detail: a decoded `PaymentPayload` carries `accepted: PaymentRequirements` — the exact requirements the buyer
paid against. So you verify and settle with `payload.accepted`; you don't have to re-derive which option they chose.

### MPP (`mppx` + `@inflowpayai/mpp`)

`mppx` documents two primitives that run **"without going through the HTTP 402 request lifecycle"**:

- `mppx.challenge.inflow.charge({ amount, currency })` → mints a fully HMAC-bound `Challenge` object, no response sent.
- `mppx.verifyCredential(credentialStringOrObject, options?)` → deserializes, HMAC-checks, matches the method, validates
  the payload schema, checks expiry, and runs the InFlow redeem + settle, returning a `Receipt`.

From `@inflowpayai/mpp`:

- `renderChallengeHeader(challenge)` → the `WWW-Authenticate: Payment …` header value for a `Challenge`.

(`mppx` also has `compose([...])` for combining **multiple MPP methods** behind one route via several `WWW-Authenticate`
headers — useful if you ever want several MPP methods, but it does not combine MPP with x402.)

> Not what you're after? If you only need to accept **multiple currencies over MPP** (no x402 involved), that's a
> built-in, supported feature — `@inflowpayai/mpp-seller`'s `inflowCharges` / `inflowChargesNodeListener`. You do
> **not** need this dual-protocol build for that.

---

## 5. The design

### 5.1 Unpaid request → one `402` carrying both challenges

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <encodePaymentRequiredHeader(paymentRequired)>      ← x402
WWW-Authenticate: Payment id="…", realm="…", method="inflow", …        ← MPP (renderChallengeHeader)
Cache-Control: no-store
```

### 5.2 Paid retry → dispatch on the header the buyer chose

A compliant buyer pays with exactly one protocol, so dispatch is deterministic:

- `PAYMENT-SIGNATURE` present → **x402** path: decode → `verify` → run handler → `settle` → set `PAYMENT-RESPONSE`.
- `Authorization: Payment` present → **MPP** path: `mppx.verifyCredential(...)` → run handler → set `Payment-Receipt`.
- **Both** present → reject as ambiguous (`400`). Don't try to honor both — that risks a double charge.
- **Neither** present → re-issue the dual `402` from §5.1.

---

## 6. A reusable wrapper

The dispatch logic above is identical for every protected route — only the price and the business logic change. Factor
the common parts into one wrapper built once, then apply it to as many routes as you like.

`createDualCharge(...)` captures the shared clients and returns a `dualCharge(price, handler)` function. The per-route
`handler` returns the **success body** rather than sending the response itself — that lets the wrapper own the verify →
handler → settle ordering correctly on both paths.

```ts
// dual-charge.ts — built once, reused everywhere
import type { Request, Response } from 'express';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  type InflowSellerClient,
} from '@inflowpayai/x402-seller';
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import { Mppx } from 'mppx/server';
import { inflow } from '@inflowpayai/mpp-seller';
import { renderChallengeHeader } from '@inflowpayai/mpp';

export type DualPrice = {
  x402: string; // e.g. '0.01 USDC'
  mpp: { amount: string; currency: string }; // e.g. { amount: '0.01', currency: 'USDC' }
};

// The business handler returns the success body; the wrapper sends the response.
export type DualHandler = (req: Request) => Promise<unknown> | unknown;

export function createDualCharge(deps: {
  facilitator: ReturnType<typeof createInflowFacilitator>;
  seller: InflowSellerClient;
  mppx: ReturnType<typeof Mppx.create>;
}) {
  const { facilitator, seller, mppx } = deps;

  // --- shared: emit ONE 402 carrying both challenges ---
  async function send402(req: Request, res: Response, price: DualPrice) {
    const accepts = await inflowAccepts(seller, { price: price.x402 });
    const paymentRequired = buildPaymentRequired(req, accepts); // see §7, item 2
    res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(paymentRequired));

    const challenge = await mppx.challenge.inflow.charge(price.mpp);
    res.setHeader('WWW-Authenticate', renderChallengeHeader(challenge));

    res.setHeader('Cache-Control', 'no-store');
    res.status(402).end();
  }

  // --- the per-route wrapper ---
  return function dualCharge(price: DualPrice, handler: DualHandler) {
    return async (req: Request, res: Response) => {
      const x402Sig = req.header('PAYMENT-SIGNATURE');
      const mppAuth = req.header('Authorization'); // "Payment <credential>" when present
      const mppPaying = mppAuth?.startsWith('Payment ') ?? false;

      // ambiguous: buyer sent both
      if (x402Sig && mppPaying) {
        return res.status(400).json({ error: 'send payment via exactly one protocol' });
      }

      // x402 paid path: verify → handler → settle
      if (x402Sig) {
        const payload = decodePaymentSignatureHeader(x402Sig);
        const requirements = payload.accepted; // buyer echoes the exact requirements
        const verified = await facilitator.verify(payload, requirements);
        if (!verified.isValid) return send402(req, res, price);
        const body = await handler(req);
        const settled = await facilitator.settle(payload, requirements);
        res.setHeader('PAYMENT-RESPONSE', encodePaymentResponseHeader(settled));
        return res.json(body);
      }

      // MPP paid path: verifyCredential redeems + settles via InFlow
      if (mppPaying) {
        try {
          const receipt = await mppx.verifyCredential(mppAuth!.slice('Payment '.length));
          const body = await handler(req);
          res.setHeader('Payment-Receipt', receiptToHeader(receipt)); // see §7, item 4
          return res.json(body);
        } catch {
          return send402(req, res, price); // MppRedeemProblemError / verification failure
        }
      }

      // unpaid → emit both challenges
      return send402(req, res, price);
    };
  };
}
```

Wiring it up — the shared clients are created once, and each route is a one-liner:

```ts
// server.ts
import 'dotenv/config';
import express from 'express';
import { createInflowFacilitator, createInflowSellerClient } from '@inflowpayai/x402-seller';
import { Mppx } from 'mppx/server';
import { inflow } from '@inflowpayai/mpp-seller';
import { createDualCharge } from './dual-charge.js';

const apiKey = process.env.INFLOW_API_KEY!;
const facilitator = createInflowFacilitator({ environment: 'sandbox', apiKey });
const seller = await createInflowSellerClient({ environment: 'sandbox', apiKey });
const mppx = Mppx.create({
  methods: [inflow({ apiKey, environment: 'sandbox' })],
  secretKey: process.env.MPP_SECRET_KEY,
});

const dualCharge = createDualCharge({ facilitator, seller, mppx });

const app = express();
app.use(express.json());

// Each protected route: price both protocols to the SAME value, return the body.
app.get(
  '/api/widget',
  dualCharge({ x402: '0.01 USDC', mpp: { amount: '0.01', currency: 'USDC' } }, async () => ({ widget: 42 })),
);

app.post(
  '/api/upload',
  dualCharge({ x402: '0.10 USDC', mpp: { amount: '0.10', currency: 'USDC' } }, async () => ({ status: 'received' })),
);

// …repeat for as many routes as you need — the dispatch logic is written once.
app.listen(3000);
```

The placeholders `buildPaymentRequired` and `receiptToHeader` are the two spots where you do real work — see §7. This is
illustrative, not copy-paste production code.

---

## 7. What you own (the real cost)

1. **Economic parity.** You price each protocol independently (the `x402` string vs the `mpp` `{ amount, currency }` in
   `DualPrice`). Nothing cross-checks that they're equal. A mismatch means the buyer pays a different amount depending
   on which protocol they pick. Keep a single source of truth and derive both from it.

2. **Building the x402 `PaymentRequired`.** `inflowAccepts` returns `PaymentOption[]`, but the on-wire
   `PaymentRequired.accepts` is `PaymentRequirements[]`. The normal middleware resolves options → requirements (resource
   info, any dynamic `payTo`, etc.) for you. Doing it by hand (`buildPaymentRequired`) is the fiddliest part of the x402
   half. **The cleaner route is to delegate the entire x402 half to `x402HTTPResourceServer`**: build one with your
   route config + the InFlow facilitator, call `processHTTPRequest(ctx)` to get the `402` instructions (including the
   encoded `PAYMENT-REQUIRED` header) and `processSettlement(...)` after your handler — then the wrapper only
   hand-merges the MPP `WWW-Authenticate` header onto its `402`. That keeps option resolution, verification, and
   settlement on the supported core and minimizes what you reimplement.

3. **Lifecycle correctness.** The wrapper verifies before the handler runs and settles after a successful body — mirror
   that ordering if you change it, and handle settlement failure by returning a fresh `402` rather than a `200`.

4. **Receipts and encoding.** Encode the MPP `Receipt` to its `Payment-Receipt` header form (`receiptToHeader`), and the
   x402 `SettleResponse` to `PAYMENT-RESPONSE` (via `encodePaymentResponseHeader`). Don't leak one protocol's artifacts
   onto the other's path.

5. **Lost middleware conveniences.** Paywall HTML, route-config validation, facilitator-wide extension merging, request
   hooks, and idempotency helpers are no longer automatic. Re-add only what you need.

6. **Idempotency & double-spend.** Because a buyer pays via one protocol, the ambiguity guard in the wrapper is what
   prevents a double charge. Keep it. For retries, lean on each protocol's idempotency (`Idempotency-Key` on InFlow's
   mutating MPP routes; the x402 facilitator's settle semantics).

7. **API stability.** `encodePaymentRequiredHeader`, `x402HTTPResourceServer`, `mppx.challenge`, and
   `mppx.verifyCredential` are lower-level than the one-call middleware. They can change across SDK versions more
   readily than the supported surface. Pin `@x402/core` and `mppx` versions and re-verify the flow on every upgrade.
