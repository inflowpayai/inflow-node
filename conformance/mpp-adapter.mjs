import { createHmac } from 'node:crypto';

import {
  canonicalize,
  decode,
  encode,
  parseChallengeHeader,
  renderChallengeHeader,
} from '../packages/mpp/dist/index.js';
import { Credential, Receipt } from '../packages/mpp/node_modules/mppx/dist/index.js';

const operationErrorTypes = {
  'base64url.decode': 'encoding_error',
  'base64url.encode': 'encoding_error',
  'challenge.format': 'format_error',
  'challenge.id': 'generation_error',
  'challenge.parse': 'parse_error',
  'credential.format': 'format_error',
  'credential.parse': 'parse_error',
  'receipt.format': 'format_error',
  'receipt.parse': 'parse_error',
};

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function toWireChallenge(value) {
  const challenge = requireRecord(value, 'challenge');
  return {
    ...challenge,
    request: encode(requireRecord(challenge.request, 'challenge.request')),
  };
}

function fromWireChallenge(value) {
  return {
    ...value,
    request: decode(value.request, 'challenge request'),
  };
}

function generateChallengeId(input) {
  const request = requireRecord(input.request ?? {}, 'request');
  const requestWire = Buffer.from(canonicalize(request), 'utf8').toString('base64url');
  const payload = [
    input.realm ?? '',
    input.method ?? '',
    input.intent ?? '',
    requestWire,
    input.expires ?? '',
    input.digest ?? '',
    input.opaque ?? '',
  ].join('|');
  return createHmac('sha256', requireString(input.secretKey, 'secretKey')).update(payload).digest('base64url');
}

function execute(op, rawInput) {
  const input = requireRecord(rawInput, 'input');
  switch (op) {
    case 'challenge.parse':
      return fromWireChallenge(parseChallengeHeader(requireString(input.header, 'header')));
    case 'challenge.format':
      return { header: renderChallengeHeader(toWireChallenge(input)) };
    case 'credential.parse':
      return Credential.deserialize(requireString(input.header, 'header'));
    case 'credential.format':
      return { header: Credential.serialize(Credential.from(input)) };
    case 'receipt.parse':
      return Receipt.deserialize(requireString(input.header, 'header'));
    case 'receipt.format':
      return { header: Receipt.serialize(Receipt.from(input)) };
    case 'base64url.encode':
      return { text: Buffer.from(requireString(input.text, 'text'), 'utf8').toString('base64url') };
    case 'base64url.decode':
      return { text: Buffer.from(requireString(input.text, 'text'), 'base64url').toString('utf8') };
    case 'challenge.id':
      return { id: generateChallengeId(input) };
    default:
      throw new Error(`Unsupported operation: ${op}`);
  }
}

let source = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) source += chunk;

let request;
try {
  request = JSON.parse(source);
  const value = execute(requireString(request.op, 'op'), request.input);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (cause) {
  const op = request?.op;
  const type = operationErrorTypes[op] ?? 'unknown_error';
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stdout.write(JSON.stringify({ ok: false, error: { type, message } }));
}
