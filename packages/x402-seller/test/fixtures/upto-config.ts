import type { X402ConfigResponse, X402SupportedKind } from '@inflowpayai/x402';
import { x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress } from '@x402/evm';

import { SAMPLE_CONFIG } from './config-response.js';

export const UPTO_KIND: X402SupportedKind = {
  x402Version: 2,
  scheme: 'upto',
  network: 'eip155:8453',
  extra: {
    assetTransferMethod: 'permit2',
    permit2Proxy: x402UptoPermit2ProxyAddress,
    facilitatorAddress: '0x0000000000000000000000000000000000000002',
  },
};

export const UPTO_CONFIG: X402ConfigResponse = {
  ...SAMPLE_CONFIG,
  supported: [...SAMPLE_CONFIG.supported, UPTO_KIND],
  wallets: [
    {
      address: '0x0000000000000000000000000000000000000001',
      blockchain: 'BASE',
      network: 'eip155:8453',
    },
  ],
  assets: [
    {
      assetTransferMethod: 'eip3009',
      assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      assetName: 'USDC',
      blockchain: 'BASE',
      currency: 'USDC',
      decimals: 6,
      network: 'eip155:8453',
      permit2Proxy: x402ExactPermit2ProxyAddress,
      tokenName: 'USD Coin',
      tokenVersion: '2',
    },
  ],
};
