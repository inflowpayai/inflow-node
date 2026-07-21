import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  decode,
  decodeCredential,
  decodeReceipt,
  encode,
  parseChallengeHeader,
  renderChallengeHeader,
} from '../../src/codec.js';
import type { MppChallenge } from '../../src/types.js';

// Byte-exact wire vectors produced by the server's real MppCodec / Jcs / MppChallenge renderer
// (inflow-server: ai.inflowpay.mpp.model.MppCodecVectorsTest, fixed deterministic inputs). These lock the TypeScript
// codec to the Java canonicalisation: `canonicalize` must reproduce each `json` exactly, `encode` must reproduce each
// `b64url`, and `renderChallengeHeader` must reproduce the `WWW-Authenticate` header byte-for-byte. A drift here would
// silently break the server's HMAC binding. Regenerate by re-running the server test if the wire contract changes.

// Post-06 (native issuance): the request nests methodDetails{rail, instrumentId?}; there is no flat
// rail/blockchain/walletAddress and no opaque challenge field. These strings are regenerated from the server
// producer test (inflow-server: ai.inflowpay.mpp.model.MppCodecVectorsTest).
const REQUEST_BALANCE_B64 =
  'eyJhbW91bnQiOiIxMC41IiwiY3VycmVuY3kiOiJVU0RDIiwibWV0aG9kRGV0YWlscyI6eyJyYWlsIjoiYmFsYW5jZSJ9LCJyZWNpcGllbnQiOiIxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEifQ';

const REQUEST_INSTRUMENT_B64 =
  'eyJhbW91bnQiOiIxMC41IiwiY3VycmVuY3kiOiJVU0QiLCJtZXRob2REZXRhaWxzIjp7Imluc3RydW1lbnRJZCI6IjMzMzMzMzMzLTMzMzMtMzMzMy0zMzMzLTMzMzMzMzMzMzMzMyIsInJhaWwiOiJpbnN0cnVtZW50In0sInJlY2lwaWVudCI6IjExMTExMTExLTExMTEtMTExMS0xMTExLTExMTExMTExMTExMSJ9';

interface Vector {
  readonly name: string;
  readonly json: string;
  readonly b64url: string;
}

const VECTORS: readonly Vector[] = [
  {
    name: 'request_balance',
    json: `{"amount":"10.5","currency":"USDC","methodDetails":{"rail":"balance"},"recipient":"11111111-1111-1111-1111-111111111111"}`,
    b64url: REQUEST_BALANCE_B64,
  },
  {
    name: 'request_instrument',
    json: `{"amount":"10.5","currency":"USD","methodDetails":{"instrumentId":"33333333-3333-3333-3333-333333333333","rail":"instrument"},"recipient":"11111111-1111-1111-1111-111111111111"}`,
    b64url: REQUEST_INSTRUMENT_B64,
  },
  {
    name: 'credential_balance',
    json: `{"challenge":{"expires":"2026-05-30T12:05:00Z","id":"qB3wChallengeId","intent":"charge","method":"inflow","realm":"api.inflowpay.ai","request":"${REQUEST_BALANCE_B64}"},"payload":{"approvalId":"appr_0001","transactionId":"44444444-4444-4444-4444-444444444444","type":"balance"},"source":"did:inflow:22222222-2222-2222-2222-222222222222"}`,
    b64url:
      'eyJjaGFsbGVuZ2UiOnsiZXhwaXJlcyI6IjIwMjYtMDUtMzBUMTI6MDU6MDBaIiwiaWQiOiJxQjN3Q2hhbGxlbmdlSWQiLCJpbnRlbnQiOiJjaGFyZ2UiLCJtZXRob2QiOiJpbmZsb3ciLCJyZWFsbSI6ImFwaS5pbmZsb3dwYXkuYWkiLCJyZXF1ZXN0IjoiZXlKaGJXOTFiblFpT2lJeE1DNDFJaXdpWTNWeWNtVnVZM2tpT2lKVlUwUkRJaXdpYldWMGFHOWtSR1YwWVdsc2N5STZleUp5WVdsc0lqb2lZbUZzWVc1alpTSjlMQ0p5WldOcGNHbGxiblFpT2lJeE1URXhNVEV4TVMweE1URXhMVEV4TVRFdE1URXhNUzB4TVRFeE1URXhNVEV4TVRFaWZRIn0sInBheWxvYWQiOnsiYXBwcm92YWxJZCI6ImFwcHJfMDAwMSIsInRyYW5zYWN0aW9uSWQiOiI0NDQ0NDQ0NC00NDQ0LTQ0NDQtNDQ0NC00NDQ0NDQ0NDQ0NDQiLCJ0eXBlIjoiYmFsYW5jZSJ9LCJzb3VyY2UiOiJkaWQ6aW5mbG93OjIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyMiJ9',
  },
  {
    name: 'receipt_success',
    json: '{"challengeId":"qB3wChallengeId","method":"inflow","reference":"0xdeadbeef","settlement":{"amount":"10.5","currency":"USDC"},"status":"success","timestamp":"2026-05-30T12:05:00Z"}',
    b64url:
      'eyJjaGFsbGVuZ2VJZCI6InFCM3dDaGFsbGVuZ2VJZCIsIm1ldGhvZCI6ImluZmxvdyIsInJlZmVyZW5jZSI6IjB4ZGVhZGJlZWYiLCJzZXR0bGVtZW50Ijp7ImFtb3VudCI6IjEwLjUiLCJjdXJyZW5jeSI6IlVTREMifSwic3RhdHVzIjoic3VjY2VzcyIsInRpbWVzdGFtcCI6IjIwMjYtMDUtMzBUMTI6MDU6MDBaIn0',
  },
];

describe('server byte-parity vectors', () => {
  for (const vector of VECTORS) {
    describe(vector.name, () => {
      it('canonicalises to the server JSON byte-for-byte', () => {
        expect(canonicalize(JSON.parse(vector.json))).toBe(vector.json);
      });

      it('encodes to the server base64url byte-for-byte', () => {
        expect(encode(JSON.parse(vector.json))).toBe(vector.b64url);
      });

      it('decodes the server base64url to the same value', () => {
        expect(decode(vector.b64url)).toEqual(JSON.parse(vector.json));
      });
    });
  }

  it('typed decoders read the server credential and receipt', () => {
    const credentialVector = VECTORS.find((vector) => vector.name === 'credential_balance')!;
    const credential = decodeCredential(credentialVector.b64url);
    expect(credential.source).toBe('did:inflow:22222222-2222-2222-2222-222222222222');
    expect(credential.challenge.method).toBe('inflow');
    expect(credential.payload['approvalId']).toBe('appr_0001');
    // The server-minted transactionId correlation key survives the credential round-trip (native issuance).
    expect(credential.payload['transactionId']).toBe('44444444-4444-4444-4444-444444444444');

    const receiptVector = VECTORS.find((vector) => vector.name === 'receipt_success')!;
    const receipt = decodeReceipt(receiptVector.b64url);
    expect(receipt.reference).toBe('0xdeadbeef');
    expect(receipt.method).toBe('inflow');
    expect(receipt.settlement).toEqual({ amount: '10.5', currency: 'USDC' });
  });
});

describe('server WWW-Authenticate: Payment header vector', () => {
  const challenge: MppChallenge = {
    id: 'qB3wChallengeId',
    realm: 'api.inflowpay.ai',
    method: 'inflow',
    intent: 'charge',
    request: REQUEST_BALANCE_B64,
    expires: '2026-05-30T12:05:00Z',
    description: 'Pay "now" \\ later',
  };
  const serverHeader =
    `Payment id="qB3wChallengeId", realm="api.inflowpay.ai", method="inflow", intent="charge", request="${REQUEST_BALANCE_B64}", ` +
    'expires="2026-05-30T12:05:00Z", description="Pay \\"now\\" \\\\ later"';

  it('renders byte-for-byte like MppChallenge.toWwwAuthenticateValue()', () => {
    expect(renderChallengeHeader(challenge)).toBe(serverHeader);
  });

  it('parses the server header back to the original challenge (description un-escaped)', () => {
    expect(parseChallengeHeader(serverHeader)).toEqual(challenge);
  });
});
