import type { X402ConfigResponse, X402FacilitatorSupportedResponse } from '@inflowpayai/x402';

/**
 * Representative `X402ConfigResponse` shape. One EVM chain (Base) with USDC + USDT, one Solana chain with USDC, and an
 * InFlow balance payment method. All addresses are deterministic fakes.
 */
export const SAMPLE_CONFIG: X402ConfigResponse = {
  sellerId: '00000000-0000-0000-0000-000000000001',
  supported: [
    { network: 'eip155:8453', scheme: 'exact', x402Version: 2 },
    { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', scheme: 'exact', x402Version: 2 },
    { network: 'inflow:1', scheme: 'balance', x402Version: 2 },
  ],
  wallets: [
    {
      address: '0xBaseWallet0000000000000000000000000000001',
      blockchain: 'BASE',
      network: 'eip155:8453',
    },
    {
      address: 'SoLaNaWallet0000000000000000000000000000003',
      blockchain: 'SOLANA',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      feePayer: 'SoLaNaFeePayer0000000000000000000000000004',
    },
  ],
  assets: [
    {
      assetTransferMethod: 'eip3009',
      assetId: '0xUSDC_Base_address_000000000000000000000a',
      blockchain: 'BASE',
      currency: 'USDC',
      decimals: 6,
      network: 'eip155:8453',
      tokenName: 'USD Coin',
      tokenVersion: '2',
    },
    {
      assetTransferMethod: 'permit2',
      assetId: '0xUSDT_Base_address_000000000000000000000c',
      blockchain: 'BASE',
      currency: 'USDT',
      decimals: 6,
      network: 'eip155:8453',
      permit2Proxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
      tokenName: 'Tether USD',
      tokenVersion: '1',
    },
    {
      // Non-EVM: server publishes `solana` transfer method and omits EIP-712 fields.
      assetTransferMethod: 'solana',
      assetId: 'SoLaNaUSDCMint00000000000000000000000000d',
      blockchain: 'SOLANA',
      currency: 'USDC',
      decimals: 6,
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    },
  ],
  paymentMethods: [
    {
      scheme: 'balance',
      network: 'inflow:1',
      payTo: '00000000-0000-0000-0000-000000000001',
      decimals: 18,
    },
  ],
};

export const SAMPLE_SUPPORTED: X402FacilitatorSupportedResponse = {
  kinds: SAMPLE_CONFIG.supported,
  extensions: ['payment-identifier'],
  signers: {
    'eip155:8453': ['0xSigner1', '0xSigner2'],
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': ['SoLaNaSigner'],
  },
};
