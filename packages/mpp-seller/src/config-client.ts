import { METHOD_INFLOW, MPP_PROTOCOL_VERSION, MPP_SDK_VERSION, MppProtocolVersionError } from '@inflowpayai/mpp';
import type { MppClient, MppConfigResponse, MppCurrencyRail } from '@inflowpayai/mpp';

import type { LoadedConfig } from './types.js';

/**
 * The config client primes `GET /v1/mpp/config` once, version-gates the PSP, and exposes the slice the `inflow` method
 * needs (feature flags and the currency → rail map). The fetch is memoised: the first {@link InflowConfigClient.load}
 * call performs the request and runs the gate; subsequent calls return the same cached result (or re-reject with the
 * same gate error). Construct it inside the `inflow` factory and share it across charges.
 *
 * It mirrors `@inflowpayai/x402-seller`'s seller-client (prime-once, cache-forever) and, like it, never carries the
 * binding `secretKey` — that secret lives only on `Mppx.create`.
 */
export interface InflowConfigClient {
  /**
   * Fetch (once) and cache the PSP config, running the protocol/SDK version gate on first load.
   *
   * @returns The resolved, version-gated config slice the SDK consumes.
   * @throws {@link MppProtocolVersionError} When the PSP's `protocolVersion` differs from this SDK's supported version,
   *   or this SDK is below the PSP's advertised `minSdkVersion`.
   */
  load(): Promise<LoadedConfig>;
}

/**
 * Construct an {@link InflowConfigClient} over an existing {@link MppClient} (shared with the method's redeem path).
 * Holds a single in-flight/cached config promise.
 *
 * @param client - The shared MPP REST client.
 * @returns A memoised config client.
 */
export function createConfigClient(client: MppClient): InflowConfigClient {
  // Memoised config promise: assigned on first `load()`, reused thereafter. A rejected gate is sticky (the same
  // rejection is replayed) so a misconfigured PSP fails the same way on every charge rather than silently retrying.
  let cached: Promise<LoadedConfig> | undefined;

  async function fetchAndGate(): Promise<LoadedConfig> {
    const config = await client.getConfig();
    assertVersionCompatible(config);
    return {
      featureFlags: config.featureFlags,
      currencyRails: extractCurrencyRails(config),
    };
  }

  function load(): Promise<LoadedConfig> {
    cached ??= fetchAndGate();
    return cached;
  }

  return { load };
}

/**
 * Hard version gate, analogous to `@inflowpayai/x402`'s mismatch check. The SDK does not negotiate: an incompatibility
 * is surfaced at config time as {@link MppProtocolVersionError}.
 *
 * @param config - The fetched PSP config.
 * @throws {@link MppProtocolVersionError} On a protocol-version mismatch or an SDK below the PSP's floor.
 */
function assertVersionCompatible(config: MppConfigResponse): void {
  if (config.protocolVersion !== MPP_PROTOCOL_VERSION) {
    throw new MppProtocolVersionError('protocol', MPP_PROTOCOL_VERSION, config.protocolVersion);
  }
  if (isBelow(MPP_SDK_VERSION, config.minSdkVersion)) {
    throw new MppProtocolVersionError('sdk', MPP_SDK_VERSION, config.minSdkVersion);
  }
}

/**
 * Pull the `inflow` method's currency → rail capability map out of `supportedMethods`. Returns an empty map when the
 * PSP advertises no `inflow` method or no rails (so every currency fails the capability check rather than throwing
 * here).
 *
 * @param config - The fetched PSP config.
 * @returns The currency → rail map for `inflow`.
 */
function extractCurrencyRails(config: MppConfigResponse): Record<string, MppCurrencyRail> {
  const method = config.supportedMethods.find((entry) => entry.id === METHOD_INFLOW);
  return method?.methodDetails?.currencyRails ?? {};
}

/**
 * Compare two dotted numeric semver cores (`major.minor.patch`), ignoring any pre-release/build suffix. Returns whether
 * `version` is strictly below `floor`. Tolerant of differing segment counts (missing segments read as `0`).
 *
 * @param version - This SDK's version.
 * @param floor - The PSP's advertised minimum.
 * @returns `true` when `version < floor`.
 */
function isBelow(version: string, floor: string): boolean {
  const a = parseCore(version);
  const b = parseCore(floor);
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/**
 * Parse the leading `major.minor.patch` integers of a semver string, dropping any `-prerelease`/`+build` suffix.
 *
 * @param version - The semver string.
 * @returns A 3-tuple of non-negative integers (non-numeric segments read as `0`).
 */
function parseCore(version: string): [number, number, number] {
  const core = version.split(/[-+]/, 1)[0] ?? '';
  const parts = core.split('.').map((segment) => {
    const n = Number.parseInt(segment, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
