export const INFLOW_EIP7702_GAS_SPONSORING = 'inflowEip7702GasSponsoring';

export interface InflowEip7702GasSponsoringDeclaration {
  /** Custom InFlow extension version; not the ERC-20 approval sponsorship protocol. */
  info: { version: '1' };
}

export interface InflowEip7702GasSponsoringInfo {
  /** Custom InFlow extension version. */
  version: '1';
  /** Immutable hosted preparation identifier. */
  sponsorshipId: string;
  /** Owner's personal-sign signature over the prepared user-operation hash. */
  signature: `0x${string}`;
  /** Owner's EIP-7702 authorization signature when delegation is required. */
  authorizationSignature?: `0x${string}`;
}

export function declareInflowEip7702GasSponsoringExtension(): Record<string, InflowEip7702GasSponsoringDeclaration> {
  return { [INFLOW_EIP7702_GAS_SPONSORING]: { info: { version: '1' } } };
}
