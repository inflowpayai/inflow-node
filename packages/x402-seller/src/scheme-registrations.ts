import { EXTRA_KEYS, SCHEMES } from '@inflowpayai/x402';
import type { PaymentScheme } from '@inflowpayai/x402';
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
import { uptoSupportedKind } from './upto.js';

/**
 * Structural shape of the foundation adapters' `SchemeRegistration` interface — `{ network, server }` — declared
 * locally so this package stays platform-neutral. Express, Fastify, Hono, and Next.js compose the interface from the
 * same `@x402/core/types`, so {@link InflowSchemeRegistration} is structurally assignable to all four.
 */
export interface InflowSchemeRegistration {
  network: Network;
  server: SchemeNetworkServer;
}

export interface InflowSchemeRegistrationsOptions {
  /** Match the route's scheme selection. `upto` requires explicit inclusion and the optional `@x402/evm` peer. */
  schemes?: PaymentScheme[];
}

interface RegistrationAccumulator {
  network: string;
  scheme: string;
  assetTransferMethods: [string, ...string[]];
  seenAssetTransferMethods: Set<string>;
}

/**
 * Pass these registrations through the foundation adapter's `schemes` argument: scheme registration is checked before
 * facilitator support. Multiple assets on one network share a registration. `upto` requires explicit selection and
 * loads the optional `@x402/evm` peer; fixed-price schemes use passthrough servers.
 */
export async function inflowSchemeRegistrations(
  client: InflowSellerClient,
  options: InflowSchemeRegistrationsOptions = {},
): Promise<InflowSchemeRegistration[]> {
  const config = await client.config();
  const registrations = new Map<string, RegistrationAccumulator>();

  function add(scheme: string, network: string, assetTransferMethod: unknown): void {
    if (options.schemes !== undefined && !options.schemes.includes(scheme)) return;
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
    if (options.schemes?.includes(SCHEMES.UPTO) && uptoSupportedKind(config, asset) !== undefined) {
      add(SCHEMES.UPTO, asset.network, 'permit2');
    }
  }

  // Non-blockchain entries: scheme + network from each payment method
  // (e.g. `'balance' / 'inflow:1'`). Every scheme the server publishes
  // registers; the SDK does not enumerate an allowlist.
  for (const method of config.paymentMethods) {
    add(method.scheme, method.network, getExtra<unknown>(method.extra, EXTRA_KEYS.ASSET_TRANSFER_METHOD));
  }

  let uptoServer: SchemeNetworkServer | undefined;
  if ([...registrations.values()].some((registration) => registration.scheme === SCHEMES.UPTO)) {
    try {
      const { UptoEvmScheme } = await import('@x402/evm/upto/server');
      uptoServer = new UptoEvmScheme();
    } catch (cause) {
      throw new Error('Cannot load the upto scheme. Install the optional peer @x402/evm@^2.22.0.', { cause });
    }
  }

  return [...registrations.values()].map((registration) => ({
    // Boundary cast to the foundation's `${string}:${string}` Network
    // type. Every value passing through (CAIP-2 chain ids and
    // `'inflow:1'`) is CAIP-2 shaped at runtime.
    network: registration.network as Network,
    server:
      registration.scheme === SCHEMES.UPTO && uptoServer !== undefined
        ? uptoServer
        : inflowPassthroughScheme(registration.scheme, registration.assetTransferMethods),
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
      assetTransferMethods.map((assetTransferMethod) => [
        assetTransferMethod,
        { supported: ['authorization'], default: 'authorization' },
      ]),
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
