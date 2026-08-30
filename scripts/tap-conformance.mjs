import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

class ConformanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const vectorsUrl = new URL('../docs/tap/request-signing-vectors.json', import.meta.url);
const negativeUrl = new URL('../docs/tap/negative-vectors.json', import.meta.url);
const vectors = JSON.parse(await readFile(vectorsUrl, 'utf8'));
const negativeVectors = JSON.parse(await readFile(negativeUrl, 'utf8'));
const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(vectors.testKey.privateSeedHex, 'hex'),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = createPublicKey({
  key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(vectors.testKey.publicKeyHex, 'hex'),
  ]),
  format: 'der',
  type: 'spki',
});
const positives = new Map(vectors.positive.map((vector) => [vector.id, vector]));

for (const vector of vectors.positive) validatePositive(vector);

for (const negative of negativeVectors.negative) {
  const source = positives.get(negative.source);
  if (source === undefined) throw new Error(`${negative.id}: unknown source ${negative.source}`);
  const input = structuredClone(source);
  const context = {
    replayedNonces: new Set(),
    verificationTime: input.signatureParameters.created + 1,
  };
  applyNegative(negative, input, context);
  let actualError;
  try {
    validateRequest(input, context);
  } catch (error) {
    actualError = error instanceof ConformanceError ? error.code : undefined;
  }
  if (actualError !== negative.expectedError) {
    throw new Error(`${negative.id}: expected ${negative.expectedError}, received ${actualError ?? 'success'}`);
  }
}

console.log(
  `TAP conformance passed: ${vectors.positive.length} positive and ${negativeVectors.negative.length} negative vectors.`,
);

function applyNegative(negative, input, context) {
  if (negative.verificationTime !== undefined) context.verificationTime = negative.verificationTime;
  if (negative.precondition?.verifiedNonce !== undefined) {
    context.replayedNonces.add(negative.precondition.verifiedNonce.join('\u0000'));
  }
  for (const [path, value] of Object.entries(negative.mutation ?? {})) {
    if (path === 'removeCoveredComponent') continue;
    if (path === 'request.bodyUtf8') {
      input.request.bodyBase64 = Buffer.from(value).toString('base64');
      continue;
    }
    setPath(input, path.split('.'), value);
  }
  const removed = negative.mutation?.removeCoveredComponent;
  if (removed !== undefined) {
    input.coveredComponents = input.coveredComponents.filter((component) => component !== removed);
  }
}

function validatePositive(vector) {
  if (buildSignatureInput(vector) !== vector.signatureInput) {
    throw new Error(`${vector.id}: Signature-Input mismatch`);
  }
  if (buildSignatureBase(vector) !== vector.signatureBase) {
    throw new Error(`${vector.id}: signature base mismatch`);
  }
  if (vector.request.bodyBase64 !== undefined) {
    const body = Buffer.from(vector.request.bodyBase64, 'base64');
    if (contentDigest(body) !== vector.request.contentDigest) throw new Error(`${vector.id}: content digest mismatch`);
  }
  if (!verify(null, Buffer.from(vector.signatureBase), publicKey, parseSignature(vector.signature))) {
    throw new Error(`${vector.id}: signature verification failed`);
  }
  const generated = sign(null, Buffer.from(vector.signatureBase), privateKey);
  if (!generated.equals(parseSignature(vector.signature)))
    throw new Error(`${vector.id}: signature generation mismatch`);
}

function validateRequest(vector, context) {
  const required = ['@method', '@authority', '@path', '@query'];
  if (vector.request.bodyBase64 !== undefined) required.push('content-digest', 'content-type');
  if (required.some((component) => !vector.coveredComponents.includes(component))) {
    throw new ConformanceError('SIGNATURE_INPUT_INVALID');
  }
  const parameters = vector.signatureParameters;
  if (!['agent-browser-auth', 'agent-payer-auth'].includes(parameters.tag)) {
    throw new ConformanceError('SIGNATURE_INPUT_INVALID');
  }
  if (!['ed25519', 'Ed25519'].includes(parameters.alg)) {
    throw new ConformanceError('SIGNATURE_INPUT_INVALID');
  }
  if (parameters.expires - parameters.created > 480 || parameters.expires <= parameters.created) {
    throw new ConformanceError('SIGNATURE_LIFETIME_INVALID');
  }
  if (context.verificationTime < parameters.created) throw new ConformanceError('SIGNATURE_NOT_YET_VALID');
  if (context.verificationTime >= parameters.expires) throw new ConformanceError('SIGNATURE_EXPIRED');
  if (parameters.keyid !== vectors.testKey.keyid) throw new ConformanceError('KEY_NOT_FOUND');
  if (vector.request.bodyBase64 !== undefined) {
    const body = Buffer.from(vector.request.bodyBase64, 'base64');
    if (contentDigest(body) !== vector.request.contentDigest) throw new ConformanceError('CONTENT_DIGEST_INVALID');
  }
  const reconstructed = buildSignatureBase(vector);
  if (!verify(null, Buffer.from(reconstructed), publicKey, parseSignature(vector.signature))) {
    throw new ConformanceError('SIGNATURE_INVALID');
  }
  const nonceKey = `${parameters.keyid}\u0000${parameters.nonce}`;
  if (context.replayedNonces.has(nonceKey)) throw new ConformanceError('NONCE_REPLAYED');
}

function buildSignatureInput(vector) {
  const components = vector.coveredComponents.map((component) => `"${component}"`).join(' ');
  const parameters = vector.signatureParameters;
  return `sig2=(${components});created=${parameters.created};expires=${parameters.expires};keyid="${parameters.keyid}";alg="${parameters.alg}";nonce="${parameters.nonce}";tag="${parameters.tag}"`;
}

function buildSignatureBase(vector) {
  const values = {
    '@method': vector.request.method,
    '@authority': vector.request.authority,
    '@path': vector.request.path,
    '@query': vector.request.query,
    'content-digest': vector.request.contentDigest,
    'content-type': vector.request.contentType,
  };
  return [
    ...vector.coveredComponents.map((component) => `"${component}": ${values[component]}`),
    `"@signature-params": ${buildSignatureInput(vector).slice('sig2='.length)}`,
  ].join('\n');
}

function contentDigest(body) {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

function formatSignature(value) {
  return `sig2=:${value.toString('base64')}:`;
}

function parseSignature(value) {
  if (!value.startsWith('sig2=:') || !value.endsWith(':')) throw new ConformanceError('SIGNATURE_INPUT_INVALID');
  return Buffer.from(value.slice('sig2=:'.length, -1), 'base64');
}

function setPath(target, parts, value) {
  let current = target;
  for (const part of parts.slice(0, -1)) current = current[part];
  current[parts.at(-1)] = value;
}
