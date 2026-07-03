import { describe, expect, it } from 'vitest';

import { PROBLEM_TYPES, readHeader, readHeaderAll, transactionPath } from '../../src/constants.js';
import { resolveBaseUrl } from '../../src/environment.js';
import { InflowApiError, MppCodecError } from '../../src/errors.js';

describe('resolveBaseUrl', () => {
  it('defaults to production', () => {
    expect(resolveBaseUrl()).toBe('https://api.inflowpay.ai');
  });

  it('resolves sandbox and strips trailing slashes from an override', () => {
    expect(resolveBaseUrl({ environment: 'sandbox' })).toBe('https://sandbox.inflowpay.ai');
    expect(resolveBaseUrl({ baseUrl: 'https://local.test/api//' })).toBe('https://local.test/api');
  });
});

describe('header helpers', () => {
  it('readHeader is case-insensitive across Headers, records, and arrays', () => {
    expect(readHeader(new Headers({ 'Retry-After': '5' }), 'retry-after')).toBe('5');
    expect(readHeader({ 'Content-Type': 'application/json' }, 'content-type')).toBe('application/json');
    expect(readHeader({ 'set-cookie': ['a=1', 'b=2'] }, 'Set-Cookie')).toBe('a=1');
    expect(readHeader({}, 'missing')).toBeUndefined();
  });

  it('readHeaderAll flattens repeated record values', () => {
    expect(readHeaderAll({ 'www-authenticate': ['Payment a', 'Payment b'] }, 'WWW-Authenticate')).toEqual([
      'Payment a',
      'Payment b',
    ]);
  });

  it('transactionPath builds the poll path', () => {
    expect(transactionPath('tx-7')).toBe('/v1/transactions/tx-7/mpp');
  });
});

describe('errors', () => {
  it('InflowApiError.from extracts the server message and sanitises sensitive headers', () => {
    const err = InflowApiError.from({
      code: 'PARAMETER_INVALID',
      httpStatus: 400,
      endpoint: '/v1/mpp/challenges',
      requestId: 'req-1',
      body: { message: 'bad amount' },
      headers: { authorization: 'Bearer secret', 'x-trace': 'keep' },
    });
    expect(err.message).toBe('bad amount');
    expect(err.headers?.['authorization']).toBeUndefined();
    expect(err.headers?.['x-trace']).toBe('keep');
  });

  it('MppCodecError names the artefact', () => {
    expect(new MppCodecError('credential', 'boom').artifact).toBe('credential');
  });
});

describe('constants', () => {
  it('problem-type URIs are under the paymentauth.org base', () => {
    expect(PROBLEM_TYPES.VERIFICATION_FAILED).toBe('https://paymentauth.org/problems/verification-failed');
  });
});
