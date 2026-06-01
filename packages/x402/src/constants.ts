/**
 * X402 protocol version emitted on every outbound SDK request and required on every inbound response. Responses
 * advertising a different version are rejected at the boundary with {@link X402VersionMismatchError}.
 */
export const X402_VERSION = 2 as const;

/**
 * V2 spec header names. Emitted verbatim on the write path; read via {@link readHeader} (case-insensitive). Header
 * values use the standard base64 alphabet (`A-Z`, `a-z`, `0-9`, `+`, `/`) with `=` padding — not base64url.
 */
export const HEADERS = {
  PAYMENT_REQUIRED: 'PAYMENT-REQUIRED',
  PAYMENT_RESPONSE: 'PAYMENT-RESPONSE',
  PAYMENT_SIGNATURE: 'PAYMENT-SIGNATURE',
} as const;

/**
 * Payment-scheme identifiers carried in `PaymentRequirements.scheme` and `PaymentPayload.accepted.scheme`.
 *
 * `INSTRUMENT` is a reserved value: it is present in the type union for forward compatibility, and the SDK rejects it
 * at runtime with a typed error if reached.
 */
export const SCHEMES = {
  BALANCE: 'balance',
  EXACT: 'exact',
  INSTRUMENT: 'instrument',
} as const;

/**
 * Canonical Permit2Proxy and Permit2 addresses. Identical on every supported EVM chain (CREATE2-deployed). Use for the
 * buyer-side verification fallback when `PaymentRequirements.extra.permit2Proxy` is absent.
 */
export const CONTRACTS = {
  PERMIT2_PROXY: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const;

/**
 * Reserved network identifiers. CAIP-2 shaped `<namespace>:<reference>`. Only InFlow's internal ledger is enumerated;
 * on-chain network ids (`eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, …) are sourced at runtime from
 * `X402ConfigResponse.assets[*].network` and `wallets[*].network`.
 */
export const NETWORKS = {
  INFLOW: 'inflow:1',
} as const;

/**
 * Atomic-unit scale for amounts on InFlow's internal ledger (`inflow:1`) — the `balance` (and reserved `instrument`)
 * scheme. A `PaymentRequirements.amount` of `10n ** 18n` therefore denotes `1.0` of the asset. Mirrors the server-side
 * `X402Constants.INFLOW_AMOUNT_SCALE`. On-chain (`exact`) entries use their own per-asset decimals
 * (`X402AssetInfo.decimals`) and are unrelated to this constant.
 */
export const INFLOW_AMOUNT_SCALE = 18;

/** Well-known keys read from `PaymentRequirements.extra` and `PaymentMethodInfo.extra`. */
export const EXTRA_KEYS = {
  ASSET_NAME: 'assetName',
  ASSET_TRANSFER_METHOD: 'assetTransferMethod',
  FEE_PAYER: 'feePayer',
  NAME: 'name',
  PERMIT2_PROXY: 'permit2Proxy',
  VERSION: 'version',
} as const;

/** Well-known keys read from `PaymentPayload.payload`. */
export const PAYLOAD_KEYS = {
  TRANSACTION_ID: 'transactionId',
} as const;

/** Values that can appear in `PaymentRequirements.extra.assetTransferMethod`. */
export const ASSET_TRANSFER_METHODS = {
  EIP3009: 'eip3009',
  PERMIT2: 'permit2',
  SOLANA: 'solana',
} as const;

/**
 * Header bag accepted by {@link readHeader}. Covers WHATWG `Headers`, Node's `IncomingHttpHeaders`-style records (where
 * values may be string arrays or undefined), and plain string-valued records.
 */
export type HeaderBag = Headers | Record<string, string | readonly string[] | undefined>;

/**
 * Read a single header value case-insensitively. Returns `undefined` when the header is absent. For Node-style headers
 * whose value is an array, returns the first element.
 *
 * @param headers - The header bag to read from.
 * @param name - The header name. Matched case-insensitively against the keys in `headers`.
 * @returns The header value, or `undefined` if missing.
 */
export function readHeader(headers: HeaderBag, name: string): string | undefined {
  const target = name.toLowerCase();
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const record = headers as Record<string, string | readonly string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== target) continue;
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    return value[0];
  }
  return undefined;
}
