import { describe, expect, it } from 'vitest';

import { InflowApiError, X402VersionMismatchError } from '../../src/errors.js';

describe('InflowApiError.from', () => {
  it('uses the body message verbatim and carries diagnostics as fields', () => {
    const err = InflowApiError.from({
      code: 'PARAMETER_INVALID',
      httpStatus: 400,
      endpoint: '/v1/x402/verify',
      requestId: 'req_abc',
      body: { message: 'invalid amount' },
    });
    expect(err).toBeInstanceOf(InflowApiError);
    expect(err.name).toBe('InflowApiError');
    expect(err.code).toBe('PARAMETER_INVALID');
    expect(err.httpStatus).toBe(400);
    expect(err.endpoint).toBe('/v1/x402/verify');
    expect(err.requestId).toBe('req_abc');
    // Message is the server's human text only — endpoint / status / request id stay on the fields above.
    expect(err.message).toBe('invalid amount');
  });

  it('falls back to "request failed" when there is no body message', () => {
    const err = InflowApiError.from({
      code: 'UNEXPECTED_ERROR',
      httpStatus: 500,
      endpoint: '/v1/x402/settle',
    });
    expect(err.message).toBe('request failed');
    expect(err.requestId).toBeUndefined();
  });

  it('falls back to "request failed" when the body has no message', () => {
    const err = InflowApiError.from({
      code: 'INSUFFICIENT_FUNDS',
      httpStatus: 422,
      endpoint: '/v1/x402/settle',
      body: { code: 'INSUFFICIENT_FUNDS' },
    });
    expect(err.message).toMatch(/request failed$/u);
  });

  it('strips sensitive headers before storing', () => {
    const h = new Headers();
    h.set('content-type', 'application/json');
    h.set('Authorization', 'Bearer secret');
    h.set('X-API-KEY', 'sk_abc');
    h.set('Set-Cookie', 'sid=abc');
    h.set('X-Request-Id', 'req_xyz');
    const err = InflowApiError.from({
      code: 'UNAUTHORIZED',
      httpStatus: 401,
      endpoint: '/v1/x402/config',
      headers: h,
    });
    const stored = err.headers ?? {};
    expect(stored['content-type']).toBe('application/json');
    expect(stored['x-request-id']).toBe('req_xyz');
    expect(stored['authorization']).toBeUndefined();
    expect(stored['x-api-key']).toBeUndefined();
    expect(stored['set-cookie']).toBeUndefined();
  });

  it('strips sensitive headers when given a plain record', () => {
    const err = InflowApiError.from({
      code: 'UNAUTHORIZED',
      httpStatus: 401,
      endpoint: '/v1/x402/config',
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json',
        Cookie: 'sid=abc',
      },
    });
    expect(err.headers?.['authorization']).toBeUndefined();
    expect(err.headers?.['cookie']).toBeUndefined();
    expect(err.headers?.['content-type']).toBe('application/json');
  });

  it('attaches a parsed body as-is', () => {
    const body = { code: 'PARAMETER_INVALID', message: 'bad' };
    const err = InflowApiError.from({
      code: 'PARAMETER_INVALID',
      httpStatus: 400,
      endpoint: '/x',
      body,
    });
    expect(err.body).toBe(body);
  });

  it('propagates cause when provided', () => {
    const inner = new Error('boom');
    const err = new InflowApiError('msg', {
      code: 'NETWORK_ERROR',
      httpStatus: 0,
      endpoint: '/x',
      cause: inner,
    });
    expect(err.cause).toBe(inner);
  });
});

describe('X402VersionMismatchError', () => {
  it('reports the received version and endpoint in its message', () => {
    const err = new X402VersionMismatchError(1, '/v1/x402/verify');
    expect(err.name).toBe('X402VersionMismatchError');
    expect(err.receivedVersion).toBe(1);
    expect(err.endpoint).toBe('/v1/x402/verify');
    expect(err.message).toBe('Expected x402Version 2; got 1 on /v1/x402/verify');
  });

  it('reports "unknown" when the field was missing', () => {
    const err = new X402VersionMismatchError('unknown', '/path');
    expect(err.message).toBe('Expected x402Version 2; got unknown on /path');
  });
});
