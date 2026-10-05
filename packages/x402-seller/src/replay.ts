import { createHash } from 'node:crypto';

import type { PaymentPayload, PaymentRequirements, VerifyResponse } from '@x402/core/types';

export interface PaymentReplayResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface PaymentReplayProduct extends PaymentReplayResponse {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  declaredExtensions?: Record<string, unknown>;
}

export type PaymentReplayRecord =
  | { state: 'pending'; verification: VerifyResponse; product?: PaymentReplayProduct }
  | { state: 'completed'; verification: VerifyResponse; response: PaymentReplayResponse };

export type PaymentReplayClaim =
  | { type: 'owned'; token: string; product?: PaymentReplayProduct }
  | { type: 'pending' }
  | { type: 'conflict' }
  | { type: 'completed'; response: PaymentReplayResponse };

/**
 * Shared durable storage is mandatory. Claims are atomic and tokens fence every write. An unstaged pending operation
 * must never be reclaimed: its handler may have performed a side effect. Recovery of staged operations must atomically
 * rotate the ownership token; the facilitator must reconcile concurrent identical settlement attempts. Retain records
 * for the entire payment replay lifetime, including crashes and deployment restarts.
 */
export interface PaymentReplayStore {
  lookup(key: string, fingerprint: string): Promise<PaymentReplayRecord | 'conflict' | undefined>;
  claim(key: string, fingerprint: string, verification: VerifyResponse): Promise<PaymentReplayClaim>;
  stage(key: string, token: string, product: PaymentReplayProduct): Promise<boolean>;
  complete(key: string, token: string, response: PaymentReplayResponse): Promise<boolean>;
}

/** @internal */
export function replayDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') throw new Error('Replay fingerprints require JSON values');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
