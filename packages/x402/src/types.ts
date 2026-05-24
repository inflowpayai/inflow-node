// V2 wire-shape types and InFlow-specific response/request shapes.
//
// `network` is typed as `string` throughout (not `@x402/core`'s
// `${string}:${string}` template literal). Every InFlow value — both
// CAIP-2 chain ids (`eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, …) and the
// `'inflow:1'` ledger literal — is CAIP-2 shaped, but the SDK declines
// to narrow the type so consumer code can route opaque network strings
// without TS-level pattern checks.

import type { ResourceInfo, VerifyResponse } from '@x402/core/types';

export type { ResourceInfo, VerifyResponse };

/**
 * Payment-scheme identifier carried on the wire. `'exact'` covers EIP-3009 and Permit2 EVM transfers as well as non-EVM
 * signed transfers; `'balance'` covers InFlow internal balance transfers; `'instrument'` is reserved.
 *
 * The `(string & {})` branch keeps editor autocomplete focused on the known values while still accepting any string at
 * runtime, so consumers can interoperate with future schemes the SDK hasn't yet enumerated.
 */
export type PaymentScheme = 'exact' | 'balance' | 'instrument' | (string & {});

/** Funding-source type carried in `instrument`-scheme payloads and extras. Reserved for future use. */
export type InstrumentType = 'card' | 'bank' | (string & {});

/**
 * A single entry in `PaymentRequired.accepts[]`. Describes one acceptable way for a buyer to pay the protected
 * resource: a scheme, a network, the payee address, the asset (when applicable), the atomic-unit amount, and
 * scheme-specific extras.
 */
export interface PaymentRequirements {
  /** Payment scheme — `'exact'`, `'balance'`, or `'instrument'`. */
  scheme: PaymentScheme;
  /**
   * CAIP-2 network identifier. `'eip155:8453'` and `'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'` for blockchain networks;
   * `'inflow:1'` for InFlow's internal ledger (balance and reserved instrument schemes).
   */
  network: string;
  /** On-chain contract address or mint. Empty string when not applicable. */
  asset: string;
  /** Amount in atomic units of `asset` (or the method's own decimal scale). */
  amount: string;
  /** Recipient — wallet address for blockchain schemes, seller UUID for balance/instrument. */
  payTo: string;
  /** Maximum lifetime (seconds) the requirement is valid for. */
  maxTimeoutSeconds: number;
  /**
   * Scheme-specific extras (EIP-712 domain, asset transfer method, fee payer, etc.). Optional on the wire — the server
   * omits it when no extras apply (e.g. some `balance`-scheme entries). Use the typed accessors in
   * `@inflowpayai/x402/extras` for safe reads under `noUncheckedIndexedAccess`.
   */
  extra?: Record<string, unknown>;
}

/** The 402-response body. Sent by the seller as a base64 JSON encoding in the `PAYMENT-REQUIRED` header. */
export interface PaymentRequired {
  /** Protocol version — always `2`. */
  x402Version: number;
  /** Optional human-readable error context attached by the seller. */
  error?: string;
  /** Information about the protected resource. */
  resource: ResourceInfo;
  /** The set of acceptable payment options. The buyer chooses one. */
  accepts: PaymentRequirements[];
  /** Per-response extension declarations, keyed by extension name. */
  extensions?: Record<string, unknown>;
}

/**
 * Inner payload shape for the `'balance'` scheme. Balance payments are not cryptographically signed because settlement
 * is an internal ledger transfer rather than a verifiable on-chain action.
 */
export interface BalancePayloadData {
  /** InFlow transaction UUID — the only field carried on the wire. */
  transactionId: string;
}

/**
 * EIP-3009 (`transferWithAuthorization`) wire shape of the `'exact'` scheme. The Permit2 variant lives on
 * {@link Permit2PayloadData}.
 */
export interface ExactPayloadData {
  /** EIP-3009 `TransferWithAuthorization` typed-data message. */
  authorization: {
    /** Payer address; signs `authorization`. */
    from: string;
    /** Recipient (the seller's `payTo`). */
    to: string;
    /** Atomic-unit amount (decimal string). */
    value: string;
    /** Unix-seconds lower bound for facilitator submission. */
    validAfter: string;
    /** Unix-seconds upper bound (matches `maxTimeoutSeconds`). */
    validBefore: string;
    /** 32-byte hex; the payer must not have used it before. */
    nonce: string;
  };
  /** 65-byte EIP-712 ECDSA signature over `authorization`. */
  signature: string;
}

/** Inner payload shape for the `'instrument'` scheme. Reserved. */
export interface InstrumentPayloadData {
  transactionId: string;
  signature: string;
  instrumentId?: string;
  instrumentType?: InstrumentType;
}

/**
 * Permit2 variant of the `'exact'` scheme inner payload. See the [x402 EVM exact scheme
 * spec](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md). `spender` must be the
 * canonical x402ExactPermit2Proxy (see {@link CONTRACTS}); the InFlow facilitator rejects custom spenders.
 */
export interface Permit2PayloadData {
  signature: string;
  permit2Authorization: {
    permitted: { token: string; amount: string };
    from: string;
    spender: string;
    nonce: string;
    deadline: string;
    witness: { to: string; validAfter: string; extra: string };
  };
}

/**
 * Discriminated union of known inner-payload shapes. The catch-all `Record<string, unknown>` branch keeps the type open
 * for forward- compatible schemes the SDK hasn't yet enumerated.
 */
export type InflowPaymentPayloadData =
  | BalancePayloadData
  | ExactPayloadData
  | Permit2PayloadData
  | InstrumentPayloadData
  | Record<string, unknown>;

/**
 * The signed payment envelope a buyer sends to the seller in the `PAYMENT-SIGNATURE` header (base64 JSON). Narrow on
 * `accepted.scheme` to discriminate `payload`.
 */
export interface InflowPaymentPayload {
  /** Protocol version — always `2`. */
  x402Version: number;
  /** The {@link PaymentRequirements} the buyer chose. */
  accepted: PaymentRequirements;
  /** Scheme-specific signed (or pseudo-signed) inner payload. */
  payload: InflowPaymentPayloadData;
  /** Per-payload extension data, keyed by extension name. */
  extensions?: Record<string, unknown>;
  /** Optional resource info echoed back by the buyer. */
  resource?: ResourceInfo;
}

/** Narrows to the `'balance'` scheme branch. */
export function isBalancePayload(p: InflowPaymentPayload): p is InflowPaymentPayload & { payload: BalancePayloadData } {
  return p.accepted.scheme === 'balance';
}

/**
 * Narrows to the EIP-3009 variant of the `'exact'` scheme. The two `'exact'` variants split on transfer method — use
 * alongside {@link isPermit2Payload}.
 */
export function isExactPayload(p: InflowPaymentPayload): p is InflowPaymentPayload & { payload: ExactPayloadData } {
  return p.accepted.scheme === 'exact' && typeof (p.payload as { authorization?: unknown }).authorization === 'object';
}

/**
 * Narrows to the Permit2 variant of the `'exact'` scheme. The two `'exact'` variants split on transfer method — use
 * alongside {@link isExactPayload}.
 */
export function isPermit2Payload(p: InflowPaymentPayload): p is InflowPaymentPayload & { payload: Permit2PayloadData } {
  return (
    p.accepted.scheme === 'exact' &&
    typeof (p.payload as { permit2Authorization?: unknown }).permit2Authorization === 'object'
  );
}

/** Narrows to the reserved `'instrument'` scheme branch. Returns `false` for all production traffic today. */
export function isInstrumentPayload(
  p: InflowPaymentPayload,
): p is InflowPaymentPayload & { payload: InstrumentPayloadData } {
  return p.accepted.scheme === 'instrument';
}

/**
 * Settlement-result envelope returned by the facilitator after a settle call. `network` is CAIP-2 for blockchain
 * settlements and `'inflow:1'` for balance settlements.
 *
 * `transaction` is always present: a non-empty on-chain hash (or settlement reference for `'balance'`) on success, the
 * empty string on failure. Check `success` before treating the value as a real reference.
 */
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  /** On-chain hash on success, empty string on failure. Always present. */
  transaction: string;
  network: string;
  amount?: string;
  /** Per-extension entries returned by the facilitator. */
  extensions?: Record<string, unknown>;
}

/**
 * Per-`(scheme, network)` capability advertised by a facilitator. The optional `extra` map carries scheme- or
 * operator-specific metadata; the SDK does not interpret it.
 */
export interface X402SupportedKind {
  network: string;
  scheme: PaymentScheme;
  x402Version: number;
  extra?: Record<string, unknown>;
}

/**
 * Facilitator-wide capability response. Returned by `GET /v1/x402/supported`.
 *
 * `signers` carries the operator wallet addresses that sign settlement on the facilitator side, used by sellers for
 * trust verification of the settlement source. `extensions` enumerates the facilitator-wide extension names so
 * `inflowAccepts` can dispatch to the right handlers.
 */
export interface X402FacilitatorSupportedResponse {
  kinds: X402SupportedKind[];
  extensions?: string[];
  signers?: Record<string, string[]>;
}

/**
 * Buyer-facing capability response. Returned by `GET /v1/transactions/x402-supported`. Deliberately narrower than
 * {@link X402FacilitatorSupportedResponse}: facilitator-wide extension declarations and operator signer addresses have
 * no actionable meaning on the buyer side and are intentionally omitted.
 */
export interface X402BuyerSupportedResponse {
  kinds: X402SupportedKind[];
}

/**
 * On-chain asset metadata, per `(blockchain, currency)` pair. Read from `X402ConfigResponse.assets[]` by
 * `inflowAccepts` when constructing `'exact'`-scheme entries.
 */
export interface X402AssetInfo {
  /**
   * Default transfer method for this asset. `'eip3009'` and `'permit2'` for EVM assets; `'solana'` for Solana. The
   * `(string & {})` branch leaves room for forward-compatible methods the SDK hasn't enumerated yet (e.g.
   * `'erc7710'`).
   */
  assetTransferMethod?: 'eip3009' | 'permit2' | 'solana' | (string & {});
  /** Contract address (EVM) or mint (Solana). */
  assetId: string;
  /** Blockchain enum name as serialized in the config response. Opaque to the SDK. */
  blockchain: string;
  /** Currency code — e.g. `'USDC'`, `'USDT'`, `'PYUSD'`. */
  currency: string;
  /** On-chain decimal places for this asset (e.g. `6` for USDC on Base). */
  decimals: number;
  /** CAIP-2 network identifier (e.g. `'eip155:8453'`). Opaque to the SDK. */
  network: string;
  /**
   * Permit2 spender address the facilitator will sign settlements through. Present on EVM assets that support Permit2;
   * absent when the canonical x402ExactPermit2Proxy isn't deployed on the chain. Buyers should verify this equals
   * {@link CONTRACTS.PERMIT2_PROXY} before signing.
   */
  permit2Proxy?: string;
  /** EIP-712 domain name. Present only for EVM assets. */
  tokenName?: string;
  /** EIP-712 domain version. Present only for EVM assets. */
  tokenVersion?: string;
}

/**
 * Receiving-wallet metadata, per blockchain. Read from `X402ConfigResponse.wallets[]` by `inflowAccepts` to fill the
 * `payTo` field on `'exact'`-scheme entries.
 */
export interface X402WalletInfo {
  /** Chain-native address (EVM hex or Solana base58); used as `payTo` on `'exact'` entries. */
  address: string;
  /** Blockchain enum name — joins to `X402AssetInfo.blockchain`. Opaque to the SDK. */
  blockchain: string;
  /** Solana-only fee-payer address. */
  feePayer?: string;
  /** CAIP-2 network identifier (e.g. `'eip155:8453'`); matches `X402AssetInfo.network`. */
  network: string;
}

/**
 * Non-blockchain payment method metadata. Read from `X402ConfigResponse.paymentMethods[]` by `inflowAccepts` when
 * constructing `'balance'` and (reserved) `'instrument'` entries.
 */
export interface PaymentMethodInfo {
  /** Scheme this method handles — `'balance'` today, `'instrument'` reserved. */
  scheme: PaymentScheme;
  /** Network identifier for the method. `'inflow:1'` for `'balance'`; CAIP-2 for any future on-chain method. */
  network: string;
  /** Recipient identifier — the seller UUID for `'balance'` / `'instrument'`. */
  payTo: string;
  /** Per-method decimal scale. */
  decimals: number;
  /** Method-specific extras. Optional on the wire. */
  extra?: Record<string, unknown>;
}

/**
 * Stateless seller config response. Returned by `GET /v1/x402/config`. The seller middleware consumes this to construct
 * `PaymentRequired.accepts[]` at request time without per-route hard-coding.
 */
export interface X402ConfigResponse {
  /** Per-`(blockchain, currency)` on-chain asset metadata. */
  assets: X402AssetInfo[];
  /** Non-blockchain methods — `'balance'` and (reserved) `'instrument'`. */
  paymentMethods: PaymentMethodInfo[];
  /** Seller UUID — also the `payTo` value for non-blockchain schemes. */
  sellerId: string;
  /** Facilitator capabilities mirrored on the seller's config response. */
  supported: X402SupportedKind[];
  /** Per-blockchain receiving wallets. */
  wallets: X402WalletInfo[];
}
