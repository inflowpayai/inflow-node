/** @internal */
export function supportsUpfront(scheme: string, network: string, method: unknown): boolean {
  const transfer = method ?? 'default';
  if (scheme === 'exact') {
    if (network.startsWith('eip155:')) {
      return transfer === 'default' || transfer === 'eip3009' || transfer === 'permit2';
    }
    return network.startsWith('solana:') && (transfer === 'default' || transfer === 'solana');
  }
  return network === 'inflow:1' && (scheme === 'balance' || scheme === 'instrument') && transfer === 'default';
}
