import { ASSET_TRANSFER_METHODS, CONTRACTS, EXTRA_KEYS, SCHEMES } from '@inflowpayai/x402';
import {
  declareInflowEip7702GasSponsoringExtension,
  INFLOW_EIP7702_GAS_SPONSORING,
} from '@inflowpayai/x402/extensions';
import type { HTTPRequestContext, PaymentOption, RouteConfig } from '@x402/core/http';
import { declareEip2612GasSponsoringExtension, EIP2612_GAS_SPONSORING } from '@x402/extensions';

import { buildInflowAccepts, type InflowAcceptsOptions } from './inflow-accepts.js';
import type { InflowSellerClient } from './seller-client.js';
import type { InflowRouteResolver } from './http-resource-server.js';

export type InflowDynamicPrice = (
  context: HTTPRequestContext,
) => InflowAcceptsOptions['price'] | Promise<InflowAcceptsOptions['price']>;

export interface InflowRouteOptions extends InflowAcceptsOptions {
  /**
   * Select Permit2 for configured compatible on-chain assets, omitting other on-chain offers. Balance offers are
   * unaffected.
   */
  assetTransferMethod?: 'permit2';
}

/**
 * Builds a route with token-gated sponsorship declarations. Refreshes facilitator support before declaring an
 * extension. Prefers EIP-2612 when every Permit2 offer supports it; otherwise checks explicit EIP-7702 capability.
 * External wallets sign sponsorship authorizations. InFlow-managed buyers cannot sign Permit2 payments. The middleware
 * must route sponsored pairs to this client's InFlow facilitator; put it before competing facilitators.
 */
export function inflowRoute(
  client: InflowSellerClient,
  options: Omit<InflowRouteOptions, 'price'> & { price: InflowDynamicPrice },
): Promise<InflowRouteResolver>;
export function inflowRoute(client: InflowSellerClient, options: InflowRouteOptions): Promise<RouteConfig>;
export async function inflowRoute(
  client: InflowSellerClient,
  options: Omit<InflowRouteOptions, 'price'> & { price: InflowRouteOptions['price'] | InflowDynamicPrice },
): Promise<RouteConfig | InflowRouteResolver> {
  const config = await client.config();
  const { price, ...rest } = options;
  if (typeof price === 'function') {
    const snapshot = structuredClone(config);
    const fixed = structuredClone(rest);
    const supported = await client.refreshSupported();
    return async (context) => {
      const accepts = buildInflowAccepts(
        snapshot,
        { ...fixed, price: await price(context) },
        fixed.assetTransferMethod,
      );
      const extensions = sponsorship(accepts, supported);
      return Object.keys(extensions).length === 0 ? { accepts } : { accepts, extensions };
    };
  }
  const accepts = buildInflowAccepts(config, { ...rest, price }, options.assetTransferMethod);
  const eligible = sponsorship(accepts);
  if (Object.keys(eligible).length === 0) return { accepts };
  const extensions = sponsorship(accepts, await client.refreshSupported());
  return Object.keys(extensions).length === 0 ? { accepts } : { accepts, extensions };
}

function sponsorship(
  accepts: Pick<PaymentOption, 'scheme' | 'network' | 'extra'>[],
  supported?: Awaited<ReturnType<InflowSellerClient['refreshSupported']>>,
): Record<string, unknown> {
  const permit2Offers = accepts.filter(
    (offer) => offer.extra?.[EXTRA_KEYS.ASSET_TRANSFER_METHOD] === ASSET_TRANSFER_METHODS.PERMIT2,
  );
  if (
    permit2Offers.length === 0 ||
    !permit2Offers.every((offer) => {
      const proxy = offer.extra?.[EXTRA_KEYS.PERMIT2_PROXY];
      return (
        offer.scheme === SCHEMES.EXACT &&
        offer.network.startsWith('eip155:') &&
        typeof proxy === 'string' &&
        proxy.toLowerCase() === CONTRACTS.PERMIT2_PROXY.toLowerCase()
      );
    })
  )
    return {};

  const eip2612 = permit2Offers.every((offer) => {
    const name = offer.extra?.[EXTRA_KEYS.NAME];
    const version = offer.extra?.[EXTRA_KEYS.VERSION];
    return (
      offer.extra?.[EXTRA_KEYS.SUPPORTS_EIP2612] === true &&
      typeof name === 'string' &&
      name !== '' &&
      typeof version === 'string' &&
      version !== ''
    );
  });
  const eip7702 = permit2Offers.every((offer) => offer.extra?.[EXTRA_KEYS.SUPPORTS_EIP7702] === true);
  if (!eip2612 && !eip7702) return {};
  if (supported === undefined)
    return eip2612 ? declareEip2612GasSponsoringExtension() : declareInflowEip7702GasSponsoringExtension();
  const supportsKinds = (requireEip7702: boolean) =>
    permit2Offers.every((offer) =>
      supported.kinds.some(
        (kind) =>
          kind.x402Version === 2 &&
          kind.scheme === offer.scheme &&
          kind.network === offer.network &&
          (!requireEip7702 || kind.extra?.[EXTRA_KEYS.SUPPORTS_EIP7702] === true),
      ),
    );
  if (eip2612 && supported.extensions?.includes(EIP2612_GAS_SPONSORING.key) === true && supportsKinds(false)) {
    return declareEip2612GasSponsoringExtension();
  }
  if (eip7702 && supported.extensions?.includes(INFLOW_EIP7702_GAS_SPONSORING) === true && supportsKinds(true)) {
    return declareInflowEip7702GasSponsoringExtension();
  }
  return {};
}
