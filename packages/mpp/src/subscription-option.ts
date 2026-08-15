import { createHash } from 'node:crypto';

import { canonicalize, decode } from './codec.js';
import type { InflowChallengeRequest, MppChallenge } from './types.js';

export interface SubscriptionOptionFingerprint {
  fingerprint: string;
  optionId: string;
}

export function subscriptionOptionFingerprints(
  challenges: readonly MppChallenge[],
): readonly (SubscriptionOptionFingerprint | undefined)[] {
  const options = challenges.map(subscriptionOptionFingerprint);
  const fingerprints = [...new Set(options.flatMap((option) => (option === undefined ? [] : [option.fingerprint])))];
  const identifiers = uniqueFingerprintPrefixes(fingerprints);

  return options.map((option) => {
    if (option === undefined) return undefined;
    return { fingerprint: option.fingerprint, optionId: identifiers.get(option.fingerprint) ?? option.optionId };
  });
}

/** @internal */
export function uniqueFingerprintPrefixes(fingerprints: readonly string[]): ReadonlyMap<string, string> {
  const distinct = [...new Set(fingerprints)];
  return new Map(
    distinct.map((fingerprint) => {
      let length = 12;
      while (
        length < fingerprint.length &&
        distinct.some((candidate) => candidate !== fingerprint && candidate.startsWith(fingerprint.slice(0, length)))
      ) {
        length += 1;
      }
      return [fingerprint, fingerprint.slice(0, length)];
    }),
  );
}

/** Derive a stable identifier from subscription terms, excluding volatile challenge and absolute-expiry fields. */
export function subscriptionOptionFingerprint(challenge: MppChallenge): SubscriptionOptionFingerprint | undefined {
  if (challenge.intent !== 'subscription') return undefined;
  let request: InflowChallengeRequest;
  try {
    request = decode<InflowChallengeRequest>(challenge.request, 'challenge request');
  } catch {
    return undefined;
  }
  const projection = {
    version: 1,
    method: challenge.method,
    intent: challenge.intent,
    amount: normalizeDecimal(request.amount),
    currency: request.currency,
    ...(request.recipient === undefined ? {} : { recipient: request.recipient }),
    ...(request.methodDetails?.rail === undefined ? {} : { rail: request.methodDetails.rail }),
    ...(request.periodCount === undefined ? {} : { periodCount: request.periodCount }),
    ...(request.periodUnit === undefined ? {} : { periodUnit: request.periodUnit }),
    ...(request.externalId === undefined ? {} : { externalId: request.externalId }),
  };
  const fingerprint = createHash('sha256').update(canonicalize(projection)).digest('hex');
  return { fingerprint, optionId: fingerprint.slice(0, 12) };
}

function normalizeDecimal(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const normalizedInteger = integer.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  const magnitude = normalizedFraction.length === 0 ? normalizedInteger : `${normalizedInteger}.${normalizedFraction}`;
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
}
