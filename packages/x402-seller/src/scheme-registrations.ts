import { SCHEMES } from '@inflowpayai/x402';
import type {
  AssetAmount,
  Network,
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

/**
 * Build the passthrough `SchemeRegistration[]` for every `(scheme, network)` pair the seller's `/v1/x402/config` can
 * emit. Pass the result as the third argument to `paymentMiddlewareFromConfig` — the foundation refuses to boot
 * otherwise (`hasRegisteredScheme` is checked before facilitator support). Deduplicated: multiple assets on the same
 * network collapse to one registration. See the architecture doc for the rationale.
 */
export async function inflowSchemeRegistrations(client: InflowSellerClient): Promise<InflowSchemeRegistration[]> {
  const config = await client.config();
  const registrations: InflowSchemeRegistration[] = [];
  const seen = new Set<string>();

  function add(scheme: string, network: string): void {
    const key = `${scheme}|${network}`;
    if (seen.has(key)) return;
    seen.add(key);
    registrations.push({
      // Boundary cast to the foundation's `${string}:${string}` Network
      // type. Every value passing through (CAIP-2 chain ids and
      // `'inflow:1'`) is CAIP-2 shaped at runtime.
      network: network as Network,
      server: inflowPassthroughScheme(scheme),
    });
  }

  // On-chain entries: `'exact'` scheme on every distinct asset.network.
  // Multiple assets per network (USDC + USDT on the same chain) collapse
  // to a single registration thanks to `seen`.
  for (const asset of config.assets) {
    add(SCHEMES.EXACT, asset.network);
  }

  // Non-blockchain entries: scheme + network from each payment method
  // (e.g. `'balance' / 'inflow:1'`). Every scheme the server publishes
  // registers; the SDK does not enumerate an allowlist.
  for (const method of config.paymentMethods) {
    add(method.scheme, method.network);
  }

  return registrations;
}

// Passthrough `SchemeNetworkServer`: declares `scheme` so
// `hasRegisteredScheme` returns true, then forwards both hooks
// unchanged. The `parsePrice` rejection on `Money`-form input is
// deliberate — non-`AssetAmount` prices reach this only when a route
// bypassed `inflowAccepts`, and we can't safely guess the asset's
// decimals here.
function inflowPassthroughScheme(scheme: string): SchemeNetworkServer {
  return {
    scheme,
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
