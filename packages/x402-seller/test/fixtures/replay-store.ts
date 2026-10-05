import type { VerifyResponse } from '@x402/core/types';

import type {
  PaymentReplayClaim,
  PaymentReplayProduct,
  PaymentReplayRecord,
  PaymentReplayResponse,
  PaymentReplayStore,
} from '../../src/replay.js';

interface Entry {
  fingerprint: string;
  token: string;
  active: boolean;
  record: PaymentReplayRecord;
}

export class TestReplayStore implements PaymentReplayStore {
  readonly entries = new Map<string, Entry>();
  fault: 'lookup' | 'claim' | 'stage' | 'complete' | undefined;
  ownershipLost: 'stage' | 'complete' | undefined;
  claims = 0;

  lookup(key: string, fingerprint: string): Promise<PaymentReplayRecord | 'conflict' | undefined> {
    if (this.fault === 'lookup') return Promise.reject(new Error('storage unavailable'));
    const entry = this.entries.get(key);
    return Promise.resolve(
      entry === undefined ? undefined : entry.fingerprint === fingerprint ? structuredClone(entry.record) : 'conflict',
    );
  }

  claim(key: string, fingerprint: string, verification: VerifyResponse): Promise<PaymentReplayClaim> {
    if (this.fault === 'claim') return Promise.reject(new Error('storage unavailable'));
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      if (entry.fingerprint !== fingerprint) return Promise.resolve({ type: 'conflict' });
      if (entry.record.state === 'completed')
        return Promise.resolve({ type: 'completed', response: structuredClone(entry.record.response) });
      if (entry.active || entry.record.product === undefined) return Promise.resolve({ type: 'pending' });
      const token = `owner-${++this.claims}`;
      entry.token = token;
      entry.active = true;
      return Promise.resolve({ type: 'owned', token, product: structuredClone(entry.record.product) });
    }
    const token = `owner-${++this.claims}`;
    this.entries.set(key, {
      fingerprint,
      token,
      active: true,
      record: { state: 'pending', verification: structuredClone(verification) },
    });
    return Promise.resolve({ type: 'owned', token });
  }

  stage(key: string, token: string, product: PaymentReplayProduct): Promise<boolean> {
    if (this.fault === 'stage') return Promise.reject(new Error('storage unavailable'));
    const entry = this.entries.get(key);
    if (
      this.ownershipLost === 'stage' ||
      entry === undefined ||
      entry.token !== token ||
      entry.record.state !== 'pending'
    )
      return Promise.resolve(false);
    entry.record.product = structuredClone(product);
    return Promise.resolve(true);
  }

  complete(key: string, token: string, response: PaymentReplayResponse): Promise<boolean> {
    if (this.fault === 'complete') return Promise.reject(new Error('storage unavailable'));
    const entry = this.entries.get(key);
    if (
      this.ownershipLost === 'complete' ||
      entry === undefined ||
      entry.token !== token ||
      entry.record.state !== 'pending' ||
      entry.record.product === undefined
    )
      return Promise.resolve(false);
    entry.record = { state: 'completed', verification: entry.record.verification, response: structuredClone(response) };
    return Promise.resolve(true);
  }

  simulateOwnerCrash(): void {
    for (const entry of this.entries.values()) entry.active = false;
  }
}
