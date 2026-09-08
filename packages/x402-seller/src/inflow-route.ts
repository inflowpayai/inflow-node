import { ASSET_TRANSFER_METHODS, CONTRACTS, EXTRA_KEYS, SCHEMES } from '@inflowpayai/x402';
import type { RouteConfig } from '@x402/core/http';
import { declareEip2612GasSponsoringExtension, EIP2612_GAS_SPONSORING } from '@x402/extensions';

import { buildInflowAccepts, type InflowAcceptsOptions } from './inflow-accepts.js';
import type { InflowSellerClient } from './seller-client.js';

export interface InflowRouteOptions extends InflowAcceptsOptions {
  /**
   * Select Permit2 for configured compatible on-chain assets, omitting other on-chain offers. Balance offers are
   * unaffected.
   */
  assetTransferMethod?: 'permit2';
}

/**
 * Builds a route with token-gated sponsorship declarations. Refreshes facilitator support before declaring an
 * extension. EIP-2612 is declared only when every Permit2 offer on the route supports it; use separate routes for
 * incompatible tokens. External wallets sign sponsorship permits. InFlow-managed buyers cannot sign Permit2 payments.
 * The middleware must route sponsored pairs to this client's InFlow facilitator; put it before competing facilitators.
 */
export async function inflowRoute(client: InflowSellerClient, options: InflowRouteOptions): Promise<RouteConfig> {
  const config = await client.config();
  const accepts = buildInflowAccepts(config, options, options.assetTransferMethod);
  const permit2Offers = accepts.filter(
    (offer) => offer.extra?.[EXTRA_KEYS.ASSET_TRANSFER_METHOD] === ASSET_TRANSFER_METHODS.PERMIT2,
  );
  if (
    permit2Offers.length === 0 ||
    !permit2Offers.every((offer) => {
      const name = offer.extra?.[EXTRA_KEYS.NAME];
      const version = offer.extra?.[EXTRA_KEYS.VERSION];
      const proxy = offer.extra?.[EXTRA_KEYS.PERMIT2_PROXY];
      return (
        offer.scheme === SCHEMES.EXACT &&
        offer.network.startsWith('eip155:') &&
        offer.extra?.[EXTRA_KEYS.SUPPORTS_EIP2612] === true &&
        typeof name === 'string' &&
        name !== '' &&
        typeof version === 'string' &&
        version !== '' &&
        typeof proxy === 'string' &&
        proxy.toLowerCase() === CONTRACTS.PERMIT2_PROXY.toLowerCase()
      );
    })
  )
    return { accepts };

  const supported = await client.refreshSupported();
  const canSponsor =
    supported.extensions?.includes(EIP2612_GAS_SPONSORING.key) === true &&
    permit2Offers.every((offer) =>
      supported.kinds.some(
        (kind) => kind.x402Version === 2 && kind.scheme === offer.scheme && kind.network === offer.network,
      ),
    );
  return canSponsor ? { accepts, extensions: declareEip2612GasSponsoringExtension() } : { accepts };
}
