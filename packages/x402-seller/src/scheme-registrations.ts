import { EXTRA_KEYS, SCHEMES } from '@inflowpayai/x402';
import { getExtra } from '@inflowpayai/x402/extras';
import { SDK_DEFAULT_ASSET_TRANSFER_METHOD } from '@x402/core/server';
import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from '@x402/core/types';

import type { InflowSellerClient } from './seller-client.js';

/**
 * Structural shape of `@x402/express` and `@x402/hono`'s `SchemeRegistration` interface — `{ network, server }` —
 * declared locally so this package stays platform-neutral. Both adapter packages export a `SchemeRegistration`
 * interface composed of the same `@x402/core/types` types, so {@link InflowSchemeRegistration} is structurally
 * assignable to either.
 */
export interface InflowSchemeRegistration {
  network: Network;
  server: SchemeNetworkServer;
}

const AUTHORIZATION_PAYMENT_FLOW: PaymentFlowConfig = {
  supported: ['authorization'],
  default: 'authorization',
};

interface RegistrationAccumulator {
  network: string;
  scheme: string;
  assetTransferMethods: [string, ...string[]];
  seenAssetTransferMethods: Set<string>;
}

/**
 * Build the passthrough `SchemeRegistration[]` for every `(scheme, network)` pair the seller's `/v1/x402/config` can
 * emit. Pass the result as the third argument to `paymentMiddlewareFromConfig` — the foundation refuses to boot
 * otherwise (`hasRegisteredScheme` is checked before facilitator support). Deduplicated: multiple assets on the same
 * network collapse to one registration. See the architecture doc for the rationale.
 */
export async function inflowSchemeRegistrations(client: InflowSellerClient): Promise<InflowSchemeRegistration[]> {
  const config = await client.config();
  const registrations = new Map<string, RegistrationAccumulator>();

  function add(scheme: string, network: string, assetTransferMethod: unknown): void {
    const key = `${scheme}|${network}`;
    // Foundation uses the SDK-only `default` sentinel when requirements
    // omit an on-wire assetTransferMethod. Non-string config values are
    // likewise ignored by foundation's resolver, so model them as omitted.
    const method = typeof assetTransferMethod === 'string' ? assetTransferMethod : SDK_DEFAULT_ASSET_TRANSFER_METHOD;
    const registration = registrations.get(key);
    if (registration === undefined) {
      registrations.set(key, {
        network,
        scheme,
        assetTransferMethods: [method],
        seenAssetTransferMethods: new Set([method]),
      });
      return;
    }

    if (!registration.seenAssetTransferMethods.has(method)) {
      registration.seenAssetTransferMethods.add(method);
      registration.assetTransferMethods.push(method);
    }
  }

  // On-chain entries: `'exact'` scheme on every distinct asset.network.
  // Multiple assets per network (USDC + USDT on the same chain) collapse
  // to a single registration while preserving every advertised transfer
  // method in config declaration order.
  for (const asset of config.assets) {
    add(SCHEMES.EXACT, asset.network, asset.assetTransferMethod);
  }

  // Non-blockchain entries: scheme + network from each payment method
  // (e.g. `'balance' / 'inflow:1'`). Every scheme the server publishes
  // registers; the SDK does not enumerate an allowlist.
  for (const method of config.paymentMethods) {
    add(method.scheme, method.network, getExtra<unknown>(method.extra, EXTRA_KEYS.ASSET_TRANSFER_METHOD));
  }

  return [...registrations.values()].map((registration) => ({
    // Boundary cast to the foundation's `${string}:${string}` Network
    // type. Every value passing through (CAIP-2 chain ids and
    // `'inflow:1'`) is CAIP-2 shaped at runtime.
    network: registration.network as Network,
    server: inflowPassthroughScheme(registration.scheme, registration.assetTransferMethods),
  }));
}

// Passthrough `SchemeNetworkServer`: declares `scheme` so
// `hasRegisteredScheme` returns true, then forwards both hooks
// unchanged. The `parsePrice` rejection on `Money`-form input is
// deliberate — non-`AssetAmount` prices reach this only when a route
// bypassed `inflowAccepts`, and we can't safely guess the asset's
// decimals here.
function inflowPassthroughScheme(
  scheme: string,
  assetTransferMethods: readonly [string, ...string[]],
): SchemeNetworkServer {
  // Foundation resolves this table with direct property access. Keep it
  // prototype-free so names such as `toString` cannot resolve to inherited
  // Object.prototype members and produce a misleading payment-flow error.
  const paymentFlows = Object.assign(
    Object.create(null) as Record<string, PaymentFlowConfig>,
    Object.fromEntries(
      assetTransferMethods.map((assetTransferMethod) => [assetTransferMethod, AUTHORIZATION_PAYMENT_FLOW]),
    ),
  );

  return {
    scheme,
    defaultAssetTransferMethod: assetTransferMethods[0],
    paymentFlows,
    parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
      const candidate: unknown = price;
      if (typeof candidate !== 'object' || candidate === null || !('asset' in candidate) || !('amount' in candidate)) {
        return Promise.reject(
          new Error(
            `inflowPassthroughScheme: parsePrice expected AssetAmount-form price ` +
              `(use inflowAccepts to build PaymentOption.price); got ${JSON.stringify(price)}`,
          ),
        );
      }
      // Reassemble explicitly so `exactOptionalPropertyTypes` is happy:
      // only attach `extra` when it's actually present.
      const assetAmount = candidate as AssetAmount;
      const out: AssetAmount =
        assetAmount.extra !== undefined
          ? { asset: assetAmount.asset, amount: assetAmount.amount, extra: assetAmount.extra }
          : { asset: assetAmount.asset, amount: assetAmount.amount };
      return Promise.resolve(out);
    },
    enhancePaymentRequirements(
      paymentRequirements: PaymentRequirements,
      _supportedKind: SupportedKind,
      _facilitatorExtensions: string[],
    ): Promise<PaymentRequirements> {
      return Promise.resolve(paymentRequirements);
    },
  };
}
