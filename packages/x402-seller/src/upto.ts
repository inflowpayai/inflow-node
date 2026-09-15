import { ASSET_TRANSFER_METHODS, EXTRA_KEYS, SCHEMES, X402_VERSION } from '@inflowpayai/x402';
import type { X402AssetInfo, X402ConfigResponse, X402SupportedKind } from '@inflowpayai/x402';
import { getExtra } from '@inflowpayai/x402/extras';

/**
 * Seller config advertises Permit2 capability per asset and the metered proxy and witness signer per supported kind.
 *
 * @internal
 */
export function uptoSupportedKind(config: X402ConfigResponse, asset: X402AssetInfo): X402SupportedKind | undefined {
  if (!asset.network.startsWith('eip155:') || !asset.permit2Proxy) return undefined;
  return config.supported.find((kind) => {
    const facilitator = getExtra<unknown>(kind.extra, EXTRA_KEYS.FACILITATOR_ADDRESS);
    const proxy = getExtra<unknown>(kind.extra, EXTRA_KEYS.PERMIT2_PROXY);
    return (
      kind.x402Version === X402_VERSION &&
      kind.scheme === SCHEMES.UPTO &&
      kind.network === asset.network &&
      getExtra<unknown>(kind.extra, EXTRA_KEYS.ASSET_TRANSFER_METHOD) === ASSET_TRANSFER_METHODS.PERMIT2 &&
      typeof facilitator === 'string' &&
      facilitator.length > 0 &&
      typeof proxy === 'string' &&
      proxy.length > 0
    );
  });
}
