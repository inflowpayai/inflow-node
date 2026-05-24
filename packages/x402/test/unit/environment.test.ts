import { describe, expect, it } from 'vitest';

import { resolveBaseUrl } from '../../src/environment.js';

describe('resolveBaseUrl', () => {
  it('returns the production URL when nothing is set', () => {
    expect(resolveBaseUrl()).toBe('https://api.inflowpay.ai');
  });

  it('returns the production URL when environment is "production"', () => {
    expect(resolveBaseUrl({ environment: 'production' })).toBe('https://api.inflowpay.ai');
  });

  it('returns the sandbox URL when environment is "sandbox"', () => {
    expect(resolveBaseUrl({ environment: 'sandbox' })).toBe('https://sandbox.inflowpay.ai');
  });

  it('returns baseUrl verbatim when provided', () => {
    expect(resolveBaseUrl({ baseUrl: 'https://dev.inflowpay.ai' })).toBe('https://dev.inflowpay.ai');
  });

  it('strips trailing slashes from baseUrl', () => {
    expect(resolveBaseUrl({ baseUrl: 'https://example.com/' })).toBe('https://example.com');
    expect(resolveBaseUrl({ baseUrl: 'https://example.com///' })).toBe('https://example.com');
  });

  it('prefers baseUrl over environment', () => {
    expect(resolveBaseUrl({ environment: 'sandbox', baseUrl: 'https://other.example.com' })).toBe(
      'https://other.example.com',
    );
  });

  it('ignores an empty-string baseUrl and falls back to environment', () => {
    expect(resolveBaseUrl({ environment: 'sandbox', baseUrl: '' })).toBe('https://sandbox.inflowpay.ai');
  });
});
