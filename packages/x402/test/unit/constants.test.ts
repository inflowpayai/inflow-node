import { describe, expect, it } from 'vitest';

import {
  ASSET_TRANSFER_METHODS,
  CONTRACTS,
  EXTRA_KEYS,
  HEADERS,
  NETWORKS,
  PAYLOAD_KEYS,
  SCHEMES,
  X402_VERSION,
  readHeader,
} from '../../src/constants.js';

describe('constants', () => {
  it('pins x402 protocol version to 2', () => {
    expect(X402_VERSION).toBe(2);
  });

  it('exposes V2 spec header names verbatim', () => {
    expect(HEADERS.PAYMENT_REQUIRED).toBe('PAYMENT-REQUIRED');
    expect(HEADERS.PAYMENT_SIGNATURE).toBe('PAYMENT-SIGNATURE');
    expect(HEADERS.PAYMENT_RESPONSE).toBe('PAYMENT-RESPONSE');
  });

  it('reserves the three payment-scheme identifiers', () => {
    expect(SCHEMES.EXACT).toBe('exact');
    expect(SCHEMES.BALANCE).toBe('balance');
    expect(SCHEMES.INSTRUMENT).toBe('instrument');
  });

  it('reserves the InFlow internal network literal (CAIP-2 shape)', () => {
    expect(NETWORKS.INFLOW).toBe('inflow:1');
  });

  it('exposes the Permit2 contract addresses', () => {
    expect(CONTRACTS.PERMIT2_PROXY).toMatch(/^0x[a-fA-F0-9]{40}$/u);
    expect(CONTRACTS.PERMIT2).toMatch(/^0x[a-fA-F0-9]{40}$/u);
  });

  it('exposes well-known extra-map and payload-map keys', () => {
    expect(EXTRA_KEYS.ASSET_NAME).toBe('assetName');
    expect(EXTRA_KEYS.ASSET_TRANSFER_METHOD).toBe('assetTransferMethod');
    expect(EXTRA_KEYS.NAME).toBe('name');
    expect(EXTRA_KEYS.VERSION).toBe('version');
    expect(EXTRA_KEYS.FEE_PAYER).toBe('feePayer');
    expect(EXTRA_KEYS.PERMIT2_PROXY).toBe('permit2Proxy');
    expect(PAYLOAD_KEYS.TRANSACTION_ID).toBe('transactionId');
    expect(ASSET_TRANSFER_METHODS.EIP3009).toBe('eip3009');
    expect(ASSET_TRANSFER_METHODS.PERMIT2).toBe('permit2');
    expect(ASSET_TRANSFER_METHODS.SOLANA).toBe('solana');
  });
});

describe('readHeader', () => {
  it('reads from a WHATWG Headers instance', () => {
    const h = new Headers();
    h.set('PAYMENT-REQUIRED', 'value1');
    expect(readHeader(h, 'PAYMENT-REQUIRED')).toBe('value1');
    expect(readHeader(h, 'payment-required')).toBe('value1');
  });

  it('returns undefined when missing on a Headers instance', () => {
    expect(readHeader(new Headers(), 'missing')).toBeUndefined();
  });

  it('reads case-insensitively from a string-valued record', () => {
    const headers: Record<string, string> = { 'Payment-Signature': 'sig' };
    expect(readHeader(headers, 'PAYMENT-SIGNATURE')).toBe('sig');
    expect(readHeader(headers, 'payment-signature')).toBe('sig');
  });

  it('returns the first element when the record value is an array', () => {
    const headers: Record<string, string[]> = { 'X-Things': ['a', 'b'] };
    expect(readHeader(headers, 'x-things')).toBe('a');
  });

  it('returns undefined when a record value is explicitly undefined', () => {
    const headers: Record<string, string | undefined> = { 'X-Missing': undefined };
    expect(readHeader(headers, 'X-Missing')).toBeUndefined();
  });

  it('returns undefined for a key not present in a plain record', () => {
    expect(readHeader({ a: '1' }, 'b')).toBeUndefined();
  });
});
