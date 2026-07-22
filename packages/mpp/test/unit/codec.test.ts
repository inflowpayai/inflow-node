import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  decode,
  decodeCredential,
  decodeReceipt,
  encode,
  encodeCredential,
  padBase64Url,
  parseChallengeHeader,
  parseChallengeHeaders,
  renderChallengeHeader,
} from '../../src/codec.js';
import { MppCodecError } from '../../src/errors.js';
import type { MppChallenge, MppCredential, MppReceipt } from '../../src/types.js';

describe('canonicalize (RFC 8785 JCS)', () => {
  it('sorts object keys by UTF-16 code unit and drops null/undefined properties', () => {
    const value = { currency: 'USDC', amount: '10', recipient: 'r', blockchain: null, walletAddress: undefined };
    expect(canonicalize(value)).toBe('{"amount":"10","currency":"USDC","recipient":"r"}');
  });

  it('escapes the C0 control set and leaves non-ASCII verbatim', () => {
    expect(canonicalize({ note: 'café\t\n"\\' })).toBe('{"note":"café\\t\\n\\"\\\\"}');
  });

  it('formats numbers per the ECMAScript Number::toString (which RFC 8785 mandates)', () => {
    expect(canonicalize({ a: 1, b: -0, c: 1.5, d: 1e21 })).toBe('{"a":1,"b":0,"c":1.5,"d":1e+21}');
  });

  it('serialises nested arrays and objects', () => {
    expect(canonicalize({ xs: [3, 1, 2], y: { b: true, a: false } })).toBe('{"xs":[3,1,2],"y":{"a":false,"b":true}}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(MppCodecError);
    expect(() => canonicalize({ n: Number.NaN })).toThrow(MppCodecError);
  });
});

describe('base64url encode/decode', () => {
  it('encodes without padding over canonical JSON and round-trips', () => {
    const value = { b: 2, a: 1 };
    const encoded = encode(value);
    expect(encoded).not.toContain('=');
    expect(decode<typeof value>(encoded)).toEqual(value);
  });

  it('encodes byte-for-byte from the canonical form', () => {
    // base64url of `{"amount":"10","currency":"usd"}`
    expect(encode({ currency: 'usd', amount: '10' })).toBe('eyJhbW91bnQiOiIxMCIsImN1cnJlbmN5IjoidXNkIn0');
  });

  it('re-pads on decode and tolerates missing padding', () => {
    expect(padBase64Url('YWJj')).toBe('YWJj');
    expect(padBase64Url('YWI')).toBe('YWI=');
    expect(padBase64Url('YQ')).toBe('YQ==');
  });

  it('rejects a base64url length that is impossible (mod 4 === 1)', () => {
    expect(() => padBase64Url('abcde')).toThrow(MppCodecError);
  });

  it('throws MppCodecError on malformed JSON', () => {
    const notJson = Buffer.from('not json', 'utf8').toString('base64url');
    expect(() => decode(notJson, 'credential')).toThrow(MppCodecError);
  });
});

const challenge: MppChallenge = {
  id: 'qB3w',
  realm: 'inflow',
  method: 'inflow',
  intent: 'charge',
  request: 'eyJhbW91bnQiOiIxMCJ9',
  expires: '2025-01-15T12:05:00Z',
  description: 'Pay "now" \\ later',
};

describe('WWW-Authenticate: Payment render/parse', () => {
  it('renders auth-params in the server field order with RFC 7235 escaping of description', () => {
    expect(renderChallengeHeader(challenge)).toBe(
      'Payment id="qB3w", realm="inflow", method="inflow", intent="charge", ' +
        'request="eyJhbW91bnQiOiIxMCJ9", expires="2025-01-15T12:05:00Z", ' +
        'description="Pay \\"now\\" \\\\ later"',
    );
  });

  it('round-trips render → parse, un-escaping the description', () => {
    expect(parseChallengeHeader(renderChallengeHeader(challenge))).toEqual(challenge);
  });

  it('matches the Payment scheme case-insensitively', () => {
    const parsed = parseChallengeHeader('payment id="x", realm="r", method="inflow", intent="charge", request="q"');
    expect(parsed.id).toBe('x');
  });

  it('rejects a non-Payment value', () => {
    expect(() => parseChallengeHeader('Bearer realm="x"')).toThrow(MppCodecError);
  });

  it('throws when a required auth-param is missing', () => {
    expect(() => parseChallengeHeader('Payment id="x", realm="r", method="inflow", intent="charge"')).toThrow(
      MppCodecError,
    );
  });

  it('rejects an empty required auth-param', () => {
    expect(() =>
      parseChallengeHeader('Payment id="", realm="r", method="inflow", intent="charge", request="e30"'),
    ).toThrow(MppCodecError);
  });

  it('rejects duplicate auth-params', () => {
    expect(() =>
      parseChallengeHeader('Payment id="x", id="y", realm="r", method="inflow", intent="charge", request="e30"'),
    ).toThrow(MppCodecError);
  });

  it('parses multiple challenges from one combined value and from an array', () => {
    const a = 'Payment id="a", realm="r", method="inflow", intent="charge", request="q1"';
    const b = 'Payment id="b", realm="r", method="inflow", intent="charge", request="q2"';
    expect(parseChallengeHeaders(`${a}, ${b}`).map((c) => c.id)).toEqual(['a', 'b']);
    expect(parseChallengeHeaders([a, b]).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('renders opaque last and round-trips it verbatim (slot-6 HMAC binding must survive)', () => {
    const withOpaque: MppChallenge = { ...challenge, opaque: 'eyJpc3MiOiJpbmZsb3cifQ' };
    const header = renderChallengeHeader(withOpaque);
    expect(header.endsWith('opaque="eyJpc3MiOiJpbmZsb3cifQ"')).toBe(true);
    expect(parseChallengeHeader(header)).toEqual(withOpaque);
  });

  it('preserves opaque when parsing a seller header (never dropped)', () => {
    const parsed = parseChallengeHeader(
      'Payment id="x", realm="r", method="inflow", intent="charge", request="q", opaque="Zm9vYmFy"',
    );
    expect(parsed.opaque).toBe('Zm9vYmFy');
  });
});

describe('credential / receipt codecs', () => {
  it('round-trips a credential, preserving the echoed opaque', () => {
    const credential: MppCredential = {
      challenge: { ...challenge, opaque: 'eyJpc3MiOiJpbmZsb3cifQ' },
      payload: { approvalId: 'appr_123' },
      source: 'did:inflow:abc',
    };
    const decoded = decodeCredential(encodeCredential(credential));
    expect(decoded).toEqual(credential);
    expect(decoded.challenge.opaque).toBe('eyJpc3MiOiJpbmZsb3cifQ');
  });

  it('rejects a credential whose challenge is missing a required field', () => {
    expect(() =>
      decodeCredential(
        encode({
          challenge: { realm: 'r', method: 'inflow', intent: 'charge', request: 'e30' },
          payload: {},
        }),
      ),
    ).toThrow(MppCodecError);
  });

  it('rejects a credential with a non-object payload', () => {
    expect(() => decodeCredential(encode({ challenge, payload: 'proof' }))).toThrow(MppCodecError);
  });

  it('decodes a receipt', () => {
    const receipt: MppReceipt = {
      challengeId: 'qB3w',
      method: 'inflow',
      reference: 'ref-1',
      settlement: { amount: '10.5', currency: 'USDC' },
      status: 'success',
      timestamp: '2025-01-15T12:05:00Z',
    };
    expect(decodeReceipt(encode(receipt))).toEqual(receipt);
  });

  it('decodes a core receipt without method-specific extensions', () => {
    const receipt = {
      method: 'tempo',
      reference: 'ref-1',
      status: 'success' as const,
      timestamp: '2025-01-15T12:05:00Z',
    };
    expect(decodeReceipt(encode(receipt))).toEqual(receipt);
  });

  it('rejects a non-RFC 3339 receipt timestamp', () => {
    expect(() =>
      decodeReceipt(encode({ method: 'tempo', reference: 'ref-1', status: 'success', timestamp: 'Jan 29 2026 12:00' })),
    ).toThrow(MppCodecError);
  });
});
