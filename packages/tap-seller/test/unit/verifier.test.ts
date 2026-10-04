import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  createTapMiddleware,
  createTapVerifier,
  MemoryTapReplayStore,
  TapVerificationError,
  VisaTapKeyResolver,
} from '../../src/index.js';
import type { TapKeyResolver, TapRequest } from '../../src/index.js';

interface Vector {
  readonly id: string;
  readonly request: {
    readonly method: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly contentType?: string;
    readonly contentDigest?: string;
    readonly bodyBase64?: string;
  };
  readonly signatureParameters: {
    readonly created: number;
    readonly expires: number;
    readonly keyid: string;
  };
  readonly signatureInput: string;
  readonly signatureBase: string;
  readonly signature: string;
}

interface Vectors {
  readonly testKey: { readonly keyid: string; readonly publicKeyHex: string; readonly privateSeedHex: string };
  readonly positive: readonly Vector[];
}

interface NegativeVector {
  readonly id: string;
  readonly source: string;
  readonly verificationTime?: number;
  readonly expectedError: string;
}

interface NegativeVectors {
  readonly negative: readonly NegativeVector[];
}

const vectors = JSON.parse(
  await readFile(new URL('../../../../docs/tap/request-signing-vectors.json', import.meta.url), 'utf8'),
) as Vectors;
const negativeVectors = JSON.parse(
  await readFile(new URL('../../../../docs/tap/negative-vectors.json', import.meta.url), 'utf8'),
) as NegativeVectors;
const publicKey = createPublicKey({
  key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(vectors.testKey.publicKeyHex, 'hex'),
  ]),
  format: 'der',
  type: 'spki',
});
const resolver: TapKeyResolver = {
  resolve(keyid, algorithm) {
    return Promise.resolve(
      keyid === vectors.testKey.keyid && algorithm === 'ed25519'
        ? { keyid, algorithm: 'ed25519', key: publicKey }
        : undefined,
    );
  },
};

describe('createTapVerifier', () => {
  it('rejects RSA key material even when a custom resolver labels it ed25519', async () => {
    const vector = required(vectors.positive[0]);
    const { privateKey, publicKey: rsaKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const claim = vi.fn().mockReturnValue(true);
    const next = vi.fn();
    const verifier = createTapVerifier({
      clock: () => vector.signatureParameters.created * 1000,
      keyResolver: {
        resolve: vi.fn().mockResolvedValue({ keyid: vectors.testKey.keyid, algorithm: 'ed25519', key: rsaKey }),
      },
      replayStore: { claim },
    });
    await expect(
      createTapMiddleware(verifier)(
        {
          ...toRequest(vector),
          headers: {
            ...toRequest(vector).headers,
            signature: `sig2=:${sign(null, Buffer.from(vector.signatureBase), privateKey).toString('base64')}:`,
          },
        },
        next,
      ),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    expect(claim).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('uses the default resolver and clock through the public verifier', async () => {
    const vector = required(vectors.positive[0]);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          keys: [
            {
              ...publicKey.export({ format: 'jwk' }),
              kid: vectors.testKey.keyid,
              alg: 'Ed25519',
            },
          ],
        }),
      ),
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(vector.signatureParameters.created * 1000);
    try {
      await expect(createTapVerifier().verify(toRequest(vector))).resolves.toMatchObject({ verified: true });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      fetch.mockRestore();
      clock.mockRestore();
    }
  });

  it.each([
    'order',
    'whitespace',
    'leading-zero',
    'created',
    'expires',
    'keyid',
    'alg',
    'nonce',
    'tag',
    'string-type',
    'decimal-type',
    'token-type',
    'bytes-type',
    'boolean-type',
    'implicit-boolean',
  ])('verifies canonical signature parameters with %s input', async (shape) => {
    const vector = required(vectors.positive[0]);
    let canonical = vector.signatureInput.slice(5);
    let supplied = canonical;
    if (shape === 'order') {
      canonical = canonical.replace(/;created=(\d+);expires=(\d+)/, ';expires=$2;created=$1');
      supplied = canonical;
    } else if (shape === 'whitespace') {
      supplied = canonical.replaceAll(' ', '   ').replaceAll(';', ';  ').replace('(', '(  ').replace(')', '  )');
    } else if (shape === 'leading-zero') {
      supplied = canonical.replace(';created=', ';created=000');
    } else {
      const prefix: Record<string, string> = {
        created: `created=${vector.signatureParameters.created + 1000}`,
        expires: 'expires=1',
        keyid: 'keyid="untrusted"',
        alg: 'alg="rsa"',
        nonce: 'nonce="other"',
        tag: 'tag="agent-payer-auth"',
        'string-type': 'created="ignored"',
        'decimal-type': 'created=1.5',
        'token-type': 'created=ignored',
        'bytes-type': 'created=:AQI=:',
        'boolean-type': 'created=?0',
        'implicit-boolean': 'created',
      };
      const field = required(prefix[shape]);
      const name = required(field.split('=')[0]);
      supplied = canonical.replace(`;${name}=`, `;${field};${name}=`);
    }
    const request = signedParameters(vector, canonical, `sig2=${supplied}`);
    const verifier = createTapVerifier({
      keyResolver: resolver,
      clock: () => vector.signatureParameters.created * 1000,
    });
    await expect(createTapMiddleware(verifier)(request, (facts) => facts)).resolves.toMatchObject({
      verified: true,
      created: vector.signatureParameters.created,
      expires: vector.signatureParameters.expires,
      keyid: vectors.testKey.keyid,
      intent: 'browse',
    });
  });

  it('unescapes key identifiers and nonces consistently for lookup, signing and replay', async () => {
    const vector = required(vectors.positive[0]);
    const keyid = 'key\\"with escapes';
    const nonce = 'nonce\\"with escapes';
    const canonical = vector.signatureInput
      .slice(5)
      .replace(/keyid="[^"]*"/, `keyid=${JSON.stringify(keyid)}`)
      .replace(/nonce="[^"]*"/, `nonce=${JSON.stringify(nonce)}`);
    const resolve = vi.fn().mockResolvedValue({ keyid, algorithm: 'ed25519', key: publicKey });
    const claim = vi.fn().mockReturnValue(true);
    const verifier = createTapVerifier({
      keyResolver: { resolve },
      replayStore: { claim },
      clock: () => vector.signatureParameters.created * 1000,
    });
    await expect(verifier.verify(signedParameters(vector, canonical))).resolves.toMatchObject({ keyid, nonce });
    expect(resolve).toHaveBeenCalledWith(keyid, 'ed25519');
    expect(claim).toHaveBeenCalledWith(keyid, nonce, vector.signatureParameters.expires);
  });

  it('does not verify a signature over raw duplicate parameters instead of their canonical form', async () => {
    const vector = required(vectors.positive[0]);
    const raw = vector.signatureInput.slice(5) + `;created=${vector.signatureParameters.created}`;
    await expect(
      createTapVerifier({ keyResolver: resolver, clock: () => vector.signatureParameters.created * 1000 }).verify(
        signedParameters(vector, raw),
      ),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('accepts outer signature whitespace and omitted base64 padding', async () => {
    const vector = required(vectors.positive[0]);
    const signature = `  ${vector.signature.replace(/=+:$/, ':')} \t`;
    await expect(
      createTapVerifier({ keyResolver: resolver, clock: () => vector.signatureParameters.created * 1000 }).verify({
        ...toRequest(vector),
        headers: { ...toRequest(vector).headers, signature },
      }),
    ).resolves.toMatchObject({ verified: true });
  });

  it('rejects a malformed overwritten byte sequence', async () => {
    const vector = required(vectors.positive[0]);
    const input = vector.signatureInput.replace(';created=', ';created=:A:;created=');
    await expect(
      createTapVerifier({ keyResolver: resolver, clock: () => vector.signatureParameters.created * 1000 }).verify({
        ...toRequest(vector),
        headers: { ...toRequest(vector).headers, 'signature-input': input },
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INPUT_INVALID' });
  });

  it.each([
    [';created=1', 'SIGNATURE_LIFETIME_INVALID'],
    [';expires=1', 'SIGNATURE_LIFETIME_INVALID'],
    [';keyid="untrusted"', 'KEY_NOT_FOUND'],
    [';alg="rsa"', 'SIGNATURE_INPUT_INVALID'],
    [';nonce="other"', 'SIGNATURE_INVALID'],
    [';tag="agent-payer-auth"', 'SIGNATURE_INVALID'],
  ])('rejects an unsigned effective parameter change %s', async (suffix, code) => {
    const vector = required(vectors.positive[0]);
    const claim = vi.fn().mockReturnValue(true);
    const next = vi.fn();
    const verifier = createTapVerifier({
      keyResolver: resolver,
      replayStore: { claim },
      clock: () => vector.signatureParameters.created * 1000,
    });
    await expect(
      createTapMiddleware(verifier)(
        {
          ...toRequest(vector),
          headers: {
            ...toRequest(vector).headers,
            'signature-input': vector.signatureInput + suffix,
          },
        },
        next,
      ),
    ).rejects.toMatchObject({ code });
    expect(claim).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ';created="1"',
    ';created=1.0',
    ';created=?1',
    ';created',
    ';created=:AQI=:',
    ';created=token',
    ';created=1000000000000000',
    ';created=1e3',
    ';created=+1',
    ';created=1.0000',
    ';expires="1"',
    ';keyid=1',
    ';keyid=""',
    ';nonce=1',
    ';nonce=""',
    ';alg=1',
    ';tag=1',
    ';keyid="bad\\escape"',
    ';keyid="bad\u007f"',
    ';unknown=1',
    '; created =1',
    ';\tcreated=1',
    ';created=1 ;created=2',
    ';created=1\n',
    ';created=1\r',
    ';created=1, sig3=()',
  ])('rejects malformed or incorrectly typed parameters %s', async (suffix) => {
    const vector = required(vectors.positive[0]);
    const resolve = vi.fn();
    const verifier = createTapVerifier({
      keyResolver: { resolve },
      clock: () => vector.signatureParameters.created * 1000,
    });
    await expect(
      verifier.verify({
        ...toRequest(vector),
        headers: {
          ...toRequest(vector).headers,
          'signature-input': vector.signatureInput + suffix,
        },
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INPUT_INVALID' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['created', 'expires', 'keyid', 'alg', 'nonce', 'tag'])('requires the %s parameter', async (name) => {
    const vector = required(vectors.positive[0]);
    const input = vector.signatureInput.replace(new RegExp(`;${name}=(?:"[^"]*"|[0-9]+)`), '');
    await expect(
      createTapVerifier({ keyResolver: resolver }).verify({
        ...toRequest(vector),
        headers: {
          ...toRequest(vector).headers,
          'signature-input': input,
        },
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INPUT_INVALID' });
  });

  it.each(['missing', 'undefined', 'empty-array', 'multiple-values', 'duplicate-case', 'headers'])(
    'rejects %s content-type even with a signature over an empty field',
    async (shape) => {
      const vector = required(vectors.positive.find((candidate) => candidate.request.bodyBase64 !== undefined));
      const request = toRequest(vector);
      const privateKey = createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          Buffer.from(vectors.testKey.privateSeedHex, 'hex'),
        ]),
        format: 'der',
        type: 'pkcs8',
      });
      const base = vector.signatureBase.replace(/"content-type": [^\n]*/, '"content-type": ');
      const headers: Record<string, string | readonly string[] | undefined> = {
        'signature-input': vector.signatureInput,
        signature: `sig2=:${sign(null, Buffer.from(base), privateKey).toString('base64')}:`,
        'content-digest': vector.request.contentDigest,
      };
      if (shape === 'undefined') headers['content-type'] = undefined;
      if (shape === 'empty-array') headers['content-type'] = [];
      if (shape === 'multiple-values') headers['content-type'] = ['application/json', 'text/plain'];
      if (shape === 'duplicate-case') {
        headers['content-type'] = 'application/json';
        headers['Content-Type'] = 'text/plain';
      }
      const resolve = vi.fn((keyid: string, algorithm: string) => resolver.resolve(keyid, algorithm));
      const claim = vi.fn().mockReturnValue(true);
      const middleware = createTapMiddleware(
        createTapVerifier({
          keyResolver: { resolve },
          replayStore: { claim },
          clock: () => vector.signatureParameters.created * 1000,
        }),
      );
      const next = vi.fn();
      const suppliedHeaders =
        shape === 'headers'
          ? new Headers(
              Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
            )
          : headers;
      await expect(middleware({ ...request, headers: suppliedHeaders }, next)).rejects.toMatchObject({
        code: 'SIGNATURE_INPUT_INVALID',
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    },
  );

  it.each(['headers', 'array', 'uppercase'])('verifies body headers supplied as %s', async (shape) => {
    const vector = required(vectors.positive.find((candidate) => candidate.request.bodyBase64 !== undefined));
    const request = toRequest(vector);
    const entries: [string, string][] = [
      ['signature-input', vector.signatureInput],
      ['signature', vector.signature],
      ['content-digest', required(vector.request.contentDigest)],
      ['content-type', required(vector.request.contentType)],
    ];
    const headers =
      shape === 'headers'
        ? new Headers(entries)
        : Object.fromEntries(
            entries.map(([name, value]) => [
              shape === 'uppercase' ? name.toUpperCase() : name,
              shape === 'array' ? [value] : value,
            ]),
          );
    await expect(
      createTapVerifier({ keyResolver: resolver, clock: () => vector.signatureParameters.created * 1000 }).verify({
        ...request,
        headers,
      }),
    ).resolves.toMatchObject({ verified: true, intent: 'pay' });
  });

  it('accepts a signature valid at entry even when key lookup completes after expiration', async () => {
    const vector = required(vectors.positive[0]);
    let now = vector.signatureParameters.created * 1000;
    const verifier = createTapVerifier({
      clock: () => now,
      keyResolver: {
        async resolve(keyid, algorithm) {
          now = vector.signatureParameters.expires * 1000;
          return resolver.resolve(keyid, algorithm);
        },
      },
    });
    await expect(verifier.verify(toRequest(vector))).resolves.toMatchObject({ verified: true });
  });

  it('allows only one concurrent verification of the same nonce', async () => {
    const vector = required(vectors.positive[0]);
    const verifier = createTapVerifier({
      keyResolver: resolver,
      clock: () => vector.signatureParameters.created * 1000,
    });
    const results = await Promise.allSettled([verifier.verify(toRequest(vector)), verifier.verify(toRequest(vector))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'NONCE_REPLAYED' },
    });
  });

  it('does not invoke the handler when a custom replay store fails', async () => {
    const vector = required(vectors.positive[0]);
    const error = new Error('Replay store unavailable');
    const middleware = createTapMiddleware(
      createTapVerifier({
        keyResolver: resolver,
        clock: () => vector.signatureParameters.created * 1000,
        replayStore: { claim: vi.fn().mockRejectedValue(error) },
      }),
    );
    const next = vi.fn();
    await expect(middleware(toRequest(vector), next)).rejects.toBe(error);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a malformed Signature field', async () => {
    const vector = required(vectors.positive[0]);
    const request = toRequest(vector);
    await expect(
      createTapVerifier({ keyResolver: resolver, clock: () => vector.signatureParameters.created * 1000 }).verify({
        ...request,
        headers: { ...request.headers, signature: 'invalid' },
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INPUT_INVALID' });
  });

  it.each(vectors.positive)('verifies a shared positive vector', async (vector) => {
    const verifier = createTapVerifier({
      keyResolver: resolver,
      clock: () => (vector.signatureParameters.created + 1) * 1000,
    });

    await expect(verifier.verify(toRequest(vector))).resolves.toMatchObject({
      verified: true,
      keyid: vectors.testKey.keyid,
      created: vector.signatureParameters.created,
      expires: vector.signatureParameters.expires,
    });
  });

  it.each(negativeVectors.negative)('rejects shared negative vector $id', async (negative) => {
    const vector = required(vectors.positive.find((candidate) => candidate.id === negative.source));
    const mutation = mutateNegative(negative.id, vector);
    const replayStore = new MemoryTapReplayStore(() => mutation.verificationTime * 1000);
    if (negative.id === 'nonce-replayed') {
      replayStore.claim(vector.signatureParameters.keyid, 'AAECAwQFBgcICQoLDA0ODw', vector.signatureParameters.expires);
    }
    const verifier = createTapVerifier({
      keyResolver: resolver,
      replayStore,
      clock: () => mutation.verificationTime * 1000,
    });

    await expect(verifier.verify(mutation.request)).rejects.toMatchObject({ code: negative.expectedError });
  });

  it('rejects an unregistered key', async () => {
    const vector = vectors.positive[0];
    expect(vector).toBeDefined();
    const verifier = createTapVerifier({
      keyResolver: { resolve: vi.fn().mockResolvedValue(undefined) },
      clock: () => (vector?.signatureParameters.created ?? 0) * 1000,
    });

    await expect(verifier.verify(toRequest(required(vector)))).rejects.toMatchObject({ code: 'KEY_NOT_FOUND' });
  });

  it('rejects a body whose bytes do not match the signed digest', async () => {
    const vector = required(vectors.positive.find((candidate) => candidate.request.bodyBase64 !== undefined));
    const verifier = createTapVerifier({
      keyResolver: resolver,
      clock: () => vector.signatureParameters.created * 1000,
    });

    await expect(verifier.verify({ ...toRequest(vector), body: '{}' })).rejects.toMatchObject({
      code: 'CONTENT_DIGEST_INVALID',
    });
  });

  it('rejects a replay after successful cryptographic verification', async () => {
    const vector = required(vectors.positive[0]);
    const verifier = createTapVerifier({
      keyResolver: resolver,
      clock: () => vector.signatureParameters.created * 1000,
    });
    const request = toRequest(vector);

    await verifier.verify(request);
    await expect(verifier.verify(request)).rejects.toMatchObject({ code: 'NONCE_REPLAYED' });
  });

  it('rejects expired, future, and excessive signature lifetimes', async () => {
    const vector = required(vectors.positive[0]);
    const request = toRequest(vector);
    await expect(
      createTapVerifier({ keyResolver: resolver, clock: () => vector.signatureParameters.expires * 1000 }).verify(
        request,
      ),
    ).rejects.toMatchObject({ code: 'SIGNATURE_EXPIRED' });
    await expect(
      createTapVerifier({ keyResolver: resolver, clock: () => (vector.signatureParameters.expires + 1) * 1000 }).verify(
        request,
      ),
    ).rejects.toMatchObject({ code: 'SIGNATURE_EXPIRED' });
    await expect(
      createTapVerifier({ keyResolver: resolver, clock: () => (vector.signatureParameters.created - 1) * 1000 }).verify(
        request,
      ),
    ).rejects.toMatchObject({ code: 'SIGNATURE_NOT_YET_VALID' });
    await expect(
      createTapVerifier({ keyResolver: resolver, clock: () => vector.signatureParameters.created * 1000 }).verify({
        ...request,
        headers: {
          ...request.headers,
          'signature-input': vector.signatureInput.replace(
            `expires=${vector.signatureParameters.expires}`,
            `expires=${vector.signatureParameters.created + 481}`,
          ),
        },
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_LIFETIME_INVALID' });
  });

  it('rejects malformed and cryptographically invalid signatures', async () => {
    const vector = required(vectors.positive[0]);
    const verifier = createTapVerifier({
      keyResolver: resolver,
      clock: () => vector.signatureParameters.created * 1000,
    });
    await expect(verifier.verify({ ...toRequest(vector), headers: {} })).rejects.toBeInstanceOf(TapVerificationError);
    await expect(
      verifier.verify({
        ...toRequest(vector),
        headers: { ...toRequest(vector).headers, signature: `sig2=:${Buffer.alloc(64).toString('base64')}:` },
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('rejects missing and duplicate covered components', async () => {
    const vector = required(vectors.positive[0]);
    const verifier = createTapVerifier({
      keyResolver: resolver,
      clock: () => vector.signatureParameters.created * 1000,
    });
    const request = toRequest(vector);
    await expect(
      verifier.verify({
        ...request,
        headers: { ...request.headers, 'signature-input': vector.signatureInput.replace(' "@query"', '') },
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INPUT_INVALID' });
    await expect(
      verifier.verify({
        ...request,
        headers: {
          ...request.headers,
          'signature-input': vector.signatureInput.replace('"@query")', '"@query" "@query")'),
        },
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INPUT_INVALID' });
  });

  it('rejects duplicate case-insensitive signature headers', async () => {
    const vector = required(vectors.positive[0]);
    const request = toRequest(vector);
    const verifier = createTapVerifier({
      keyResolver: resolver,
      clock: () => vector.signatureParameters.created * 1000,
    });

    await expect(
      verifier.verify({
        ...request,
        headers: {
          ...request.headers,
          'Signature-Input': vector.signatureInput,
        },
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_INPUT_INVALID' });
  });

  it('passes verified facts through the middleware primitive', async () => {
    const vector = required(vectors.positive[0]);
    const middleware = createTapMiddleware(
      createTapVerifier({ keyResolver: resolver, clock: () => vector.signatureParameters.created * 1000 }),
    );

    await expect(middleware(toRequest(vector), (facts) => facts.intent)).resolves.toBe('browse');
  });
});

describe('VisaTapKeyResolver', () => {
  it('treats an empty key-set object as no trusted keys', async () => {
    const resolver = new VisaTapKeyResolver({ fetch: vi.fn().mockResolvedValue(new Response('{}')) });
    await expect(resolver.resolve('missing', 'ed25519')).resolves.toBeUndefined();
  });
  it('retrieves an Ed25519 JWK and selects it by key identifier', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          keys: [
            {
              kty: 'OKP',
              crv: 'Ed25519',
              x: Buffer.from(vectors.testKey.publicKeyHex, 'hex').toString('base64url'),
              kid: vectors.testKey.keyid,
              use: 'sig',
              alg: 'Ed25519',
            },
          ],
        }),
      ),
    );
    const keyResolver = new VisaTapKeyResolver({ fetch: fetchMock });

    await expect(keyResolver.resolve(vectors.testKey.keyid, 'ed25519')).resolves.toMatchObject({
      keyid: vectors.testKey.keyid,
      algorithm: 'ed25519',
    });
  });

  it('uses a cached key during a temporary key-service outage', async () => {
    let now = 1_000;
    const jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(vectors.testKey.publicKeyHex, 'hex').toString('base64url'),
      kid: vectors.testKey.keyid,
      use: 'sig',
      alg: 'Ed25519',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] })))
      .mockRejectedValueOnce(new Error('offline'));
    const keyResolver = new VisaTapKeyResolver({ fetch: fetchMock, cacheTtlMs: 100, clock: () => now });

    const first = await keyResolver.resolve(vectors.testKey.keyid, 'ed25519');
    now += 101;
    const second = await keyResolver.resolve(vectors.testKey.keyid, 'ed25519');
    expect(second).toBe(first);
  });

  it('fails with retrieval error when an uncached key cannot be refreshed', async () => {
    const jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(vectors.testKey.publicKeyHex, 'hex').toString('base64url'),
      kid: vectors.testKey.keyid,
      use: 'sig',
      alg: 'Ed25519',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] })))
      .mockRejectedValueOnce(new Error('offline'));
    const keyResolver = new VisaTapKeyResolver({ fetch: fetchMock });

    await keyResolver.resolve(vectors.testKey.keyid, 'ed25519');
    await expect(keyResolver.resolve('new-key', 'ed25519')).rejects.toMatchObject({
      code: 'KEY_RETRIEVAL_FAILED',
    });
  });

  it('serves a fresh cached key without contacting the key service', async () => {
    const jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(vectors.testKey.publicKeyHex, 'hex').toString('base64url'),
      kid: vectors.testKey.keyid,
      use: 'sig',
      alg: 'Ed25519',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] })));
    const keyResolver = new VisaTapKeyResolver({ fetch: fetchMock });

    await keyResolver.resolve(vectors.testKey.keyid, 'ed25519');
    await keyResolver.resolve(vectors.testKey.keyid, 'ed25519');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('negative-caches a missing key until the key set becomes stale', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [] })));
    const keyResolver = new VisaTapKeyResolver({ fetch: fetchMock });

    await expect(keyResolver.resolve('missing', 'ed25519')).resolves.toBeUndefined();
    await expect(keyResolver.resolve('missing', 'ed25519')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes a fresh key set once when the requested key is not cached', async () => {
    const jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(vectors.testKey.publicKeyHex, 'hex').toString('base64url'),
      kid: vectors.testKey.keyid,
      use: 'sig',
      alg: 'Ed25519',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] })));
    const keyResolver = new VisaTapKeyResolver({ fetch: fetchMock });

    await expect(keyResolver.resolve('missing', 'ed25519')).resolves.toBeUndefined();
    await expect(keyResolver.resolve(vectors.testKey.keyid, 'ed25519')).resolves.toMatchObject({
      keyid: vectors.testKey.keyid,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale cached key when the key service remains unavailable', async () => {
    let now = 1_000;
    const jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(vectors.testKey.publicKeyHex, 'hex').toString('base64url'),
      kid: vectors.testKey.keyid,
      use: 'sig',
      alg: 'Ed25519',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] })))
      .mockRejectedValueOnce(new Error('offline'));
    const keyResolver = new VisaTapKeyResolver({
      fetch: fetchMock,
      cacheTtlMs: 100,
      cacheMaxAgeMs: 200,
      clock: () => now,
    });

    await keyResolver.resolve(vectors.testKey.keyid, 'ed25519');
    now += 201;
    await expect(keyResolver.resolve(vectors.testKey.keyid, 'ed25519')).rejects.toMatchObject({
      code: 'KEY_RETRIEVAL_FAILED',
    });
  });

  it('fails closed when no cached key can be retrieved', async () => {
    const keyResolver = new VisaTapKeyResolver({ fetch: vi.fn().mockRejectedValue(new Error('offline')) });

    await expect(keyResolver.resolve('unregistered', 'ed25519')).rejects.toMatchObject({
      code: 'KEY_RETRIEVAL_FAILED',
    });
  });

  it('rejects unsupported algorithms and unknown registered keys', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ keys: [] }))));
    const keyResolver = new VisaTapKeyResolver({
      fetch: fetchMock,
    });

    await expect(keyResolver.resolve('key', 'rsa')).resolves.toBeUndefined();
    await expect(keyResolver.resolve('key', 'ed25519')).resolves.toBeUndefined();
    await expect(keyResolver.resolve('another-key', 'ed25519')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent key-set refreshes', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const keyResolver = new VisaTapKeyResolver({ fetch: fetchMock });

    const first = keyResolver.resolve('first', 'ed25519');
    const second = keyResolver.resolve('second', 'ed25519');
    resolveResponse?.(new Response(JSON.stringify({ keys: [] })));
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response('', { status: 503 }),
    new Response('null', { headers: { 'content-type': 'application/json' } }),
  ])('fails closed on an invalid key-service response', async (response) => {
    const keyResolver = new VisaTapKeyResolver({ fetch: vi.fn().mockResolvedValue(response) });

    await expect(keyResolver.resolve('key', 'ed25519')).rejects.toMatchObject({ code: 'KEY_RETRIEVAL_FAILED' });
  });

  it('fails closed when the key set repeats a key identifier', async () => {
    const jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(vectors.testKey.publicKeyHex, 'hex').toString('base64url'),
      kid: vectors.testKey.keyid,
      use: 'sig',
      alg: 'Ed25519',
    };
    const keyResolver = new VisaTapKeyResolver({
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [jwk, jwk] }))),
    });

    await expect(keyResolver.resolve(vectors.testKey.keyid, 'ed25519')).rejects.toMatchObject({
      code: 'KEY_RETRIEVAL_FAILED',
    });
  });
});

describe('MemoryTapReplayStore', () => {
  it('releases expired nonce claims', () => {
    let now = 1_000_000;
    const store = new MemoryTapReplayStore(() => now);
    expect(store.claim('key', 'nonce', 1_001)).toBe(true);
    expect(store.claim('key', 'nonce', 1_001)).toBe(false);
    now = 1_002_000;
    expect(store.claim('key', 'nonce', 1_003)).toBe(true);
  });
});

function toRequest(vector: Vector): TapRequest {
  const headers: Record<string, string> = {
    'signature-input': vector.signatureInput,
    signature: vector.signature,
  };
  if (vector.request.contentType !== undefined) headers['content-type'] = vector.request.contentType;
  if (vector.request.contentDigest !== undefined) headers['content-digest'] = vector.request.contentDigest;
  const body = vector.request.bodyBase64 === undefined ? undefined : Buffer.from(vector.request.bodyBase64, 'base64');
  return {
    method: vector.request.method,
    url: `https://${vector.request.authority}${vector.request.path}${vector.request.query === '?' ? '' : vector.request.query}`,
    headers,
    ...(body === undefined ? {} : { body }),
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Test vector is missing.');
  return value;
}

function signedParameters(vector: Vector, canonical: string, supplied = `sig2=${canonical}`): TapRequest {
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(vectors.testKey.privateSeedHex, 'hex'),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const base = vector.signatureBase.replace(/"@signature-params": .*/, `"@signature-params": ${canonical}`);
  return {
    ...toRequest(vector),
    headers: {
      ...toRequest(vector).headers,
      'signature-input': supplied,
      signature: `sig2=:${sign(null, Buffer.from(base), key).toString('base64')}:`,
    },
  };
}

function mutateNegative(id: string, vector: Vector): { request: TapRequest; verificationTime: number } {
  const request = toRequest(vector);
  const headers = { ...(request.headers as Readonly<Record<string, string>>) };
  let url = new URL(request.url);
  let method = request.method;
  let body = request.body;
  let signatureInput = vector.signatureInput;
  let signature = vector.signature;
  let verificationTime = vector.signatureParameters.created + 1;
  switch (id) {
    case 'method-mutated':
      method = 'PUT';
      break;
    case 'authority-mutated':
      url = new URL(url.href.replace('merchant.example', 'attacker.example'));
      break;
    case 'path-mutated':
      url.pathname = '/checkout';
      break;
    case 'query-reordered':
      url.search = '?category=mens&category=sale&q=red%20shoes';
      break;
    case 'query-added-to-absent-query':
      url.search = '?page=1';
      break;
    case 'body-whitespace-mutated':
      body = '{"amount": "1.00","currency":"USD"}';
      break;
    case 'content-type-mutated':
      headers['content-type'] = 'application/json; charset=utf-8';
      break;
    case 'covered-component-missing':
      signatureInput = signatureInput.replace(' "content-digest"', '');
      break;
    case 'created-in-future':
      verificationTime = vector.signatureParameters.created - 1;
      break;
    case 'expired':
      verificationTime = vector.signatureParameters.expires + 1;
      break;
    case 'expires-at-verification-time':
      verificationTime = vector.signatureParameters.expires;
      break;
    case 'lifetime-over-eight-minutes':
      signatureInput = signatureInput.replace(
        `expires=${vector.signatureParameters.expires}`,
        `expires=${vector.signatureParameters.created + 481}`,
      );
      break;
    case 'nonce-replayed':
      verificationTime = 1_787_666_500;
      break;
    case 'key-unknown':
      signatureInput = signatureInput.replace(vector.signatureParameters.keyid, 'unknown-key');
      break;
    case 'algorithm-casing-unsupported':
      signatureInput = signatureInput.replace('alg="ed25519"', 'alg="ED25519"');
      break;
    case 'tag-invalid':
      signatureInput = signatureInput.replace(/tag="[^"]+"/, 'tag="unknown-intent"');
      break;
    case 'signature-bytes-mutated':
      signature = `sig2=:${Buffer.alloc(64).toString('base64')}:`;
      break;
    case 'redirect-signature-reused':
      url.pathname = '/catalog/redirected';
      break;
    default:
      throw new Error(`Unhandled negative vector: ${id}`);
  }
  return {
    request: {
      ...request,
      method,
      url,
      headers: { ...headers, 'signature-input': signatureInput, signature },
      ...(body === undefined ? {} : { body }),
    },
    verificationTime,
  };
}
