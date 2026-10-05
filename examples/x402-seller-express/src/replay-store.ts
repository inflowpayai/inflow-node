import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fchmodSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';

import type {
  PaymentReplayClaim,
  PaymentReplayProduct,
  PaymentReplayRecord,
  PaymentReplayResponse,
  PaymentReplayStore,
} from '@inflowpayai/x402-seller/express';
import type { VerifyResponse } from '@x402/core/types';

interface ReplayRow {
  fingerprint: string;
  verification: string;
  token: string;
  lease: number;
  product: string | null;
  response: string | null;
}

export class SqliteReplayStore implements PaymentReplayStore {
  private readonly database: DatabaseSync;

  constructor(file: string) {
    const descriptor = openSync(file, 'a', 0o600);
    try {
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
    this.database = new DatabaseSync(file);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS replay (
        key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        verification TEXT NOT NULL,
        token TEXT NOT NULL,
        lease INTEGER NOT NULL,
        product TEXT,
        response TEXT
      );
    `);
    for (const suffix of ['-wal', '-shm']) {
      try {
        chmodSync(`${file}${suffix}`, 0o600);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          this.database.close();
          throw error;
        }
      }
    }
  }

  lookup(key: string, fingerprint: string): Promise<PaymentReplayRecord | 'conflict' | undefined> {
    const row = this.read(key);
    if (row === undefined) return Promise.resolve(undefined);
    if (row.fingerprint !== fingerprint) return Promise.resolve('conflict');
    const verification = JSON.parse(row.verification) as VerifyResponse;
    return Promise.resolve(
      row.response !== null
        ? { state: 'completed', verification, response: decode<PaymentReplayResponse>(row.response) }
        : {
            state: 'pending',
            verification,
            ...(row.product === null ? {} : { product: decode<PaymentReplayProduct>(row.product) }),
          },
    );
  }

  claim(key: string, fingerprint: string, verification: VerifyResponse): Promise<PaymentReplayClaim> {
    const token = randomUUID();
    const now = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.read(key);
      let result: PaymentReplayClaim;
      if (row === undefined) {
        this.database
          .prepare('INSERT INTO replay(key,fingerprint,verification,token,lease) VALUES(?,?,?,?,?)')
          .run(key, fingerprint, JSON.stringify(verification), token, now + 120000);
        result = { type: 'owned', token };
      } else if (row.fingerprint !== fingerprint) result = { type: 'conflict' };
      else if (row.response !== null)
        result = { type: 'completed', response: decode<PaymentReplayResponse>(row.response) };
      else if (row.product !== null && row.lease <= now) {
        const changed = this.database
          .prepare(
            'UPDATE replay SET token=?,lease=? WHERE key=? AND token=? AND response IS NULL AND product IS NOT NULL AND lease<=?',
          )
          .run(token, now + 120000, key, row.token, now);
        result =
          changed.changes === 1
            ? { type: 'owned', token, product: decode<PaymentReplayProduct>(row.product) }
            : { type: 'pending' };
      } else result = { type: 'pending' };
      this.database.exec('COMMIT');
      return Promise.resolve(result);
    } catch (error) {
      this.database.exec('ROLLBACK');
      return Promise.reject(error instanceof Error ? error : new Error('Replay storage failed'));
    }
  }

  stage(key: string, token: string, product: PaymentReplayProduct): Promise<boolean> {
    const stored = encode(product);
    return Promise.resolve(
      this.database
        .prepare(
          'UPDATE replay SET product=?,lease=? WHERE key=? AND token=? AND response IS NULL AND (product IS NULL OR product=?)',
        )
        .run(stored, Date.now() + 120000, key, token, stored).changes === 1,
    );
  }

  complete(key: string, token: string, response: PaymentReplayResponse): Promise<boolean> {
    return Promise.resolve(
      this.database
        .prepare('UPDATE replay SET response=? WHERE key=? AND token=? AND product IS NOT NULL AND response IS NULL')
        .run(encode(response), key, token).changes === 1,
    );
  }

  close(): void {
    this.database.close();
  }

  private read(key: string): ReplayRow | undefined {
    const row: Record<string, SQLOutputValue> | undefined = this.database
      .prepare('SELECT * FROM replay WHERE key=?')
      .get(key);
    if (row === undefined) return undefined;
    const { fingerprint, verification, token, lease, product, response } = row;
    if (
      typeof fingerprint !== 'string' ||
      typeof verification !== 'string' ||
      typeof token !== 'string' ||
      typeof lease !== 'number' ||
      (product !== null && typeof product !== 'string') ||
      (response !== null && typeof response !== 'string')
    )
      throw new Error('Invalid replay storage row');
    return { fingerprint, verification, token, lease, product, response };
  }
}

function encode(value: PaymentReplayResponse): string {
  return JSON.stringify({ ...value, body: Buffer.from(value.body).toString('base64') });
}

function decode<T extends PaymentReplayResponse>(value: string): T {
  // Only this adapter writes these JSON records; SQLite preserves the schema alongside the binary body encoding.
  const record = JSON.parse(value) as Record<string, unknown>;
  if (typeof record['body'] !== 'string') throw new Error('Invalid replay response body');
  return { ...record, body: Uint8Array.from(Buffer.from(record['body'], 'base64')) } as T;
}
