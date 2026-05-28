import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeBody,
  parseHeaderFlag,
  parseHeaderFlags,
  replayWithPayment,
  sellerProbe,
  X402HeaderFlagFormatError,
} from '../../src/probe/index.js';

describe('parseHeaderFlag', () => {
  it('splits at the first colon and trims whitespace', () => {
    expect(parseHeaderFlag('X-Hello: world ')).toEqual({ name: 'X-Hello', value: 'world' });
  });

  it('preserves later colons in the value (e.g. URL or time)', () => {
    expect(parseHeaderFlag('Location: https://example.com:8443/path')).toEqual({
      name: 'Location',
      value: 'https://example.com:8443/path',
    });
  });

  it('rejects flags without a colon', () => {
    expect(() => parseHeaderFlag('NoColon')).toThrow(X402HeaderFlagFormatError);
  });

  it('rejects flags with empty name or value', () => {
    expect(() => parseHeaderFlag(': value')).toThrow(X402HeaderFlagFormatError);
    expect(() => parseHeaderFlag('Name: ')).toThrow(X402HeaderFlagFormatError);
  });

  it('captures the offending input on the error', () => {
    try {
      parseHeaderFlag('NoColon');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(X402HeaderFlagFormatError);
      expect((err as X402HeaderFlagFormatError).input).toBe('NoColon');
      expect((err as X402HeaderFlagFormatError).name).toBe('X402HeaderFlagFormatError');
    }
  });
});

describe('parseHeaderFlags', () => {
  it('returns a record keyed by header name', () => {
    expect(parseHeaderFlags(['Accept: json', 'X-Trace: abc'])).toEqual({
      Accept: 'json',
      'X-Trace': 'abc',
    });
  });

  it('the last value wins on duplicate names', () => {
    expect(parseHeaderFlags(['X: 1', 'X: 2'])).toEqual({ X: '2' });
  });

  it('returns an empty object for empty input', () => {
    expect(parseHeaderFlags([])).toEqual({});
  });
});

describe('sellerProbe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues the requested method and returns status, headers, and bytes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const result = await sellerProbe('https://seller', {
      method: 'GET',
      headers: { 'X-Trace': 'abc' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/plain');
    expect(new TextDecoder().decode(result.bytes)).toBe('hello');
  });

  it('defaults Content-Type to application/json when data is set and no override is supplied', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await sellerProbe('https://seller', {
      method: 'POST',
      headers: {},
      data: '{"x":1}',
    });
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe('{"x":1}');
  });

  it('respects a user-supplied Content-Type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await sellerProbe('https://seller', {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      data: '<x/>',
    });
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/xml');
  });
});

describe('replayWithPayment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges the PAYMENT-SIGNATURE header onto the original headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    await replayWithPayment('https://seller', {
      method: 'GET',
      headers: { 'X-Trace': 'abc' },
      paymentSignature: 'encoded-payload',
    });
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get('PAYMENT-SIGNATURE')).toBe('encoded-payload');
    expect(headers.get('X-Trace')).toBe('abc');
  });
});

describe('describeBody', () => {
  it('returns utf-8 text when the bytes decode cleanly', () => {
    const bytes = new TextEncoder().encode('hello');
    const described = describeBody(bytes);
    expect(described.text).toBe('hello');
    expect(described.size).toBe(5);
  });

  it('returns text=undefined when the bytes are not valid utf-8', () => {
    const described = describeBody(new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(described.text).toBeUndefined();
    expect(described.base64.length).toBeGreaterThan(0);
    expect(described.size).toBe(3);
  });
});
