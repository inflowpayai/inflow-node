/**
 * Encoding interop test. Validates that a `PaymentPayload` produced by the foundation
 * `x402HTTPClient.encodePaymentSignatureHeader` decodes back to a field-equivalent object via the same lenient base64 +
 * JSON parse logic the InFlow facilitator (Java) uses on the validation path.
 *
 * The Java side is `inflow-server/src/main/java/ai/inflowpay/x402/model/Codec.java`:
 *
 * - Normalises URL-safe characters (`-` → `+`, `_` → `/`)
 * - Decodes with `Base64.getMimeDecoder()` (lenient — standard or URL-safe alphabet, padding optional, whitespace
 *   tolerated)
 * - UTF-8 decodes the bytes
 * - `JSON.decode(json, PaymentPayload.class)`
 *
 * The Node-side helper below mirrors that decode path so this test stands on its own without a running facilitator. The
 * Spring controller `X402TransactionController.verifyX402Transaction(@RequestBody …)` never sees the encoded form —
 * re-encoding by the foundation transport is wire-equivalent for the facilitator as long as this round trip stays
 * clean.
 */
import { Buffer } from 'node:buffer';

import type { InflowPaymentPayload, PaymentRequirements } from '@inflowpayai/x402';
import type { PaymentPayload } from '@x402/core/types';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { describe, expect, it } from 'vitest';

const HEADER_NAME_LOWER = 'payment-signature';

/**
 * Mirror of `Codec.decodeBase64Lenient` — normalise URL-safe characters to the standard alphabet, then run through
 * Node's lenient base64 decoder. Node's `Buffer.from(s, 'base64')` is already permissive about padding and unknown
 * characters, but normalising up front keeps this helper aligned with the Java implementation step-for-step.
 */
function decodeBase64Lenient(value: string): Buffer {
  const normalised = value.replace(/-/gu, '+').replace(/_/gu, '/');
  return Buffer.from(normalised, 'base64');
}

/**
 * Mirror of `Codec.decodePaymentPayload` — lenient base64 → UTF-8 → JSON.parse. Returns the parsed payload so the test
 * can compare field-by-field against the original.
 */
function decodePaymentPayloadAsFacilitator(headerValue: string): InflowPaymentPayload {
  const decoded = decodeBase64Lenient(headerValue).toString('utf8');
  return JSON.parse(decoded) as InflowPaymentPayload;
}

function pickEncodedHeader(headers: Record<string, string>): string {
  // The foundation transport emits PAYMENT-SIGNATURE (v2) and X-PAYMENT
  // (v1 compat). Either carries the same base64 string.
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === HEADER_NAME_LOWER) return value;
  }
  throw new Error('PAYMENT-SIGNATURE header not produced by encodePaymentSignatureHeader');
}

const BALANCE_REQ: PaymentRequirements = {
  scheme: 'balance',
  network: 'inflow:1',
  asset: '',
  amount: '1000000000000000000',
  payTo: '00000000-0000-0000-0000-000000000001',
  maxTimeoutSeconds: 300,
  extra: {},
};

const PERMIT2_REQ: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '10000',
  payTo: '0xseller',
  maxTimeoutSeconds: 300,
  extra: {
    name: 'USD Coin',
    version: '2',
    assetTransferMethod: 'permit2',
    permit2Proxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
  },
};

describe('encoding round trip — JS encode → Java-equivalent decode', () => {
  it('preserves a balance payload byte-for-field across encode/decode', () => {
    const payload: InflowPaymentPayload = {
      x402Version: 2,
      accepted: BALANCE_REQ,
      payload: { transactionId: '00000000-0000-0000-0000-000000000abc' },
    };
    const http = new x402HTTPClient(new x402Client());
    const headers = http.encodePaymentSignatureHeader(payload as unknown as PaymentPayload);
    const encoded = pickEncodedHeader(headers);
    const decoded = decodePaymentPayloadAsFacilitator(encoded);
    expect(decoded).toEqual(payload);
  });

  it('preserves a Permit2 exact-scheme payload across encode/decode', () => {
    const payload: InflowPaymentPayload = {
      x402Version: 2,
      accepted: PERMIT2_REQ,
      payload: {
        signature:
          '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' +
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef00',
        permit2Authorization: {
          permitted: { token: PERMIT2_REQ.asset, amount: PERMIT2_REQ.amount },
          from: '0xbuyer',
          spender: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
          nonce: '0x1',
          deadline: '1700000000',
          witness: { to: PERMIT2_REQ.payTo, validAfter: '0', extra: '0x' },
        },
      },
    };
    const http = new x402HTTPClient(new x402Client());
    const headers = http.encodePaymentSignatureHeader(payload as unknown as PaymentPayload);
    const encoded = pickEncodedHeader(headers);
    const decoded = decodePaymentPayloadAsFacilitator(encoded);
    expect(decoded).toEqual(payload);
  });

  it('preserves a payload carrying an extensions map (payment-identifier)', () => {
    const payload: InflowPaymentPayload = {
      x402Version: 2,
      accepted: BALANCE_REQ,
      payload: { transactionId: '00000000-0000-0000-0000-000000000def' },
      extensions: { 'payment-identifier': { paymentId: 'pay_clientissuedabc1234567890' } },
    };
    const http = new x402HTTPClient(new x402Client());
    const headers = http.encodePaymentSignatureHeader(payload as unknown as PaymentPayload);
    const encoded = pickEncodedHeader(headers);
    const decoded = decodePaymentPayloadAsFacilitator(encoded);
    expect(decoded.extensions).toEqual(payload.extensions);
    expect(decoded.payload).toEqual(payload.payload);
    expect(decoded.accepted).toEqual(payload.accepted);
  });

  it('tolerates URL-safe base64 input (Codec.decodeBase64Lenient parity)', () => {
    // Some browser-emitted base64 uses `-` and `_` in place of `+` and `/`.
    // Build a payload whose JSON encodes to a byte sequence that, when
    // base64'd, contains `+` or `/`. Then convert to URL-safe form by
    // hand and confirm the decoder accepts it.
    const payload: InflowPaymentPayload = {
      x402Version: 2,
      accepted: BALANCE_REQ,
      payload: {
        // Choose a value whose UTF-8 bytes produce `+`/`/` in standard
        // base64. The string `??>>>` works (`?` is 0x3F).
        marker: '??>>>',
        transactionId: '00000000-0000-0000-0000-000000000abc',
      },
    };
    const http = new x402HTTPClient(new x402Client());
    const headers = http.encodePaymentSignatureHeader(payload as unknown as PaymentPayload);
    const encoded = pickEncodedHeader(headers);
    const urlSafe = encoded.replace(/\+/gu, '-').replace(/\//gu, '_');
    expect(urlSafe).not.toBe(encoded); // sanity: the payload actually contained `+` or `/`.
    const decoded = decodePaymentPayloadAsFacilitator(urlSafe);
    expect(decoded).toEqual(payload);
  });
});
