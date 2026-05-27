import { ASSET_TRANSFER_METHODS, EXTRA_KEYS, SCHEMES } from '@inflowpayai/x402';
import type { PaymentMethodInfo, PaymentScheme, X402AssetInfo, X402WalletInfo } from '@inflowpayai/x402';
import type { PaymentOption } from '@x402/core/http';

import { X402PriceParseError } from './errors.js';
import type { InflowSellerClient } from './seller-client.js';

const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

/** `'$X(.Y)?'` form — implies USD. Up to 8 decimal places. */
const PRICE_USD_REGEX = /^\$(\d+)(?:\.(\d{1,8}))?$/u;

/** `'X(.Y)? CURRENCY'` form — currency from suffix. */
const PRICE_WITH_CURRENCY_REGEX = /^(\d+)(?:\.(\d{1,8}))?\s+([A-Z][A-Z0-9_]*)$/u;

/** `'X(.Y)?'` bare form — currency must come from `PriceSpec.currency`. */
const PRICE_BARE_REGEX = /^(\d+)(?:\.(\d{1,8}))?$/u;

/** Price spec accepted by {@link inflowAccepts}. */
export interface PriceSpec {
  /**
   * Amount string. Three accepted forms (all supporting up to 8 decimal places):
   *
   * - `'$<integer>(.<decimals>)?'` — implies USD (e.g. `'$0.01'`, `'$10.00000001'`).
   * - `'<integer>(.<decimals>)? <CURRENCY>'` — currency from suffix (e.g. `'0.01 USDC'`, `'0.5 USDT'`, `'1 USD'`).
   * - `'<integer>(.<decimals>)?'` — bare numeric; the {@link PriceSpec.currency} field is required in this case.
   */
  amount: string;
  /**
   * Currency override. When set, takes precedence over any currency embedded in {@link PriceSpec.amount}. Required when
   * `amount` is in bare numeric form. `'USD'` is a wildcard that matches any stablecoin the seller has configured.
   */
  currency?: 'USD' | 'USDC' | 'USDT' | 'PYUSD' | (string & {});
}

/** Options accepted by {@link inflowAccepts}. */
export interface InflowAcceptsOptions {
  /**
   * Price for the protected resource. Either a {@link PriceSpec} or a string in any of the three forms accepted by
   * {@link PriceSpec.amount}.
   */
  price: PriceSpec | string;
  /**
   * Maximum lifetime (seconds) attached to each emitted entry. Defaults to `300` — matches the server-side
   * `X402Constants.INFLOW_MAX_TIMEOUT_SECONDS` constant.
   */
  maxTimeoutSeconds?: number;
  /**
   * Optional filter: emit only entries whose `scheme` is in this list. Combined with
   * {@link InflowAcceptsOptions.networks} as logical AND. Omit (or pass `undefined`) for "any scheme."
   */
  schemes?: PaymentScheme[];
  /**
   * Optional filter: emit only entries whose `network` is in this list. Combined with
   * {@link InflowAcceptsOptions.schemes} as logical AND. Omit (or pass `undefined`) for "any network."
   */
  networks?: string[];
}

/**
 * Build the `RouteConfig.accepts` array from the seller's cached `/v1/x402/config`. Each entry's `price` is
 * pre-resolved to `AssetAmount` form (asset contract address + atomic-unit amount), so the foundation middleware never
 * needs to consult the config itself. See
 * {@link https://github.com/inflowpayai/inflow-node/blob/main/docs/x402/architecture.md#inflowaccepts-algorithm | the architecture doc}
 * for the full emission and ordering rules.
 *
 * @throws {@link X402PriceParseError} When `price` matches none of the accepted forms.
 */
export async function inflowAccepts(
  client: InflowSellerClient,
  options: InflowAcceptsOptions,
): Promise<PaymentOption[]> {
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  const priceSpec = normalizePrice(options.price);
  const { amount: parsedAmount, currency: targetCurrency } = parsePriceSpec(priceSpec);
  const config = await client.config();
  const entries: PaymentOption[] = [];

  // On-chain entries: one per (wallet, matching-asset, transfer-method).
  for (const wallet of config.wallets) {
    const assets = config.assets.filter(
      (a) => a.blockchain === wallet.blockchain && currencyMatches(a.currency, targetCurrency),
    );
    for (const asset of assets) {
      const methods = resolveTransferMethods(asset);
      for (const method of methods) {
        if (!includeEntry(options, SCHEMES.EXACT, asset.network)) continue;
        entries.push(
          buildOnChainOption({
            wallet,
            asset,
            method,
            amount: factorParsed(parsedAmount, asset.decimals, priceSpec.amount),
            maxTimeoutSeconds,
          }),
        );
      }
    }
  }

  // Non-blockchain entries: one per (paymentMethod, supported stablecoin).
  // Every scheme the server publishes flows through unchanged — the SDK
  // does not gate on specific scheme names. New schemes light up as soon
  // as the server starts including them in /v1/x402/config.
  for (const method of config.paymentMethods) {
    if (!includeEntry(options, method.scheme, method.network)) continue;
    for (const currency of resolveCurrencies(config, targetCurrency)) {
      entries.push(
        buildPaymentMethodOption({
          method,
          currency,
          amount: factorParsed(parsedAmount, method.decimals, priceSpec.amount),
          maxTimeoutSeconds,
        }),
      );
    }
  }

  return entries;
}

/**
 * Stablecoins the seller's config advertises for non-blockchain methods. 'USD' expands to every distinct currency
 * present in `config.assets`; any other target returns just that currency.
 */
function resolveCurrencies(config: { assets: { currency: string }[] }, target: string): readonly string[] {
  if (target !== 'USD') return [target];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of config.assets) {
    if (!seen.has(a.currency)) {
      seen.add(a.currency);
      out.push(a.currency);
    }
  }
  return out;
}

interface OnChainOptionArgs {
  wallet: X402WalletInfo;
  asset: X402AssetInfo;
  method: string | undefined;
  amount: string;
  maxTimeoutSeconds: number;
}

function buildOnChainOption(args: OnChainOptionArgs): PaymentOption {
  const { wallet, asset, method, amount, maxTimeoutSeconds } = args;
  const extra: Record<string, unknown> = {};
  // Human-readable currency name. Emitted on every entry regardless of network so callers can render the currency without parsing `assetId`.
  extra[EXTRA_KEYS.ASSET_NAME] = asset.assetName;
  // EIP-712 domain fields are only published by the server for EVM assets.
  if (asset.tokenName !== undefined) extra[EXTRA_KEYS.NAME] = asset.tokenName;
  if (asset.tokenVersion !== undefined) extra[EXTRA_KEYS.VERSION] = asset.tokenVersion;
  if (method !== undefined) extra[EXTRA_KEYS.ASSET_TRANSFER_METHOD] = method;
  // For Permit2 entries we advertise the proxy address the facilitator expects as the EIP-712 `spender`. The address is canonical
  // (`CONTRACTS.PERMIT2_PROXY`) on every supported EVM chain, but publishing it explicitly lets third-party buyers verify it without
  // hardcoding our SDK constant — and the value is part of the signed typed-data, so the buyer needs it before signing either way.
  if (method === ASSET_TRANSFER_METHODS.PERMIT2 && asset.permit2Proxy !== undefined) {
    extra[EXTRA_KEYS.PERMIT2_PROXY] = asset.permit2Proxy;
  }
  if (wallet.feePayer !== undefined) {
    extra[EXTRA_KEYS.FEE_PAYER] = wallet.feePayer;
  }
  return {
    scheme: SCHEMES.EXACT,
    // CAIP-2 string — narrower than the foundation `Network` template
    // literal type would assume from the assignment site, so cast at the
    // construction boundary.
    network: asset.network as PaymentOption['network'],
    payTo: wallet.address,
    price: { asset: asset.assetId, amount },
    maxTimeoutSeconds,
    extra,
  };
}

interface PaymentMethodOptionArgs {
  method: PaymentMethodInfo;
  currency: string;
  amount: string;
  maxTimeoutSeconds: number;
}

function buildPaymentMethodOption(args: PaymentMethodOptionArgs): PaymentOption {
  const { method, currency, amount, maxTimeoutSeconds } = args;
  const base: PaymentOption = {
    scheme: method.scheme,
    // CAIP-2 string (`'inflow:1'` for the InFlow balance ledger).
    network: method.network as PaymentOption['network'],
    payTo: method.payTo,
    // The currency name keys the InFlow ledger that gets debited.
    price: { asset: currency, amount },
    maxTimeoutSeconds,
  };
  // Carry the row's currency as `extra.assetName` uniformly. Any server-published method.extra is merged in first; `assetName`
  // is set last so the row's resolved currency wins on conflict.
  base.extra = {
    ...(method.extra ?? {}),
    [EXTRA_KEYS.ASSET_NAME]: currency,
  };
  return base;
}

/**
 * Transfer methods to emit for an asset. The server-published `assetTransferMethod` is taken verbatim; no client-side
 * defaulting. The Permit2 proxy address is canonical and identical on every EVM chain, so the server signals Permit2
 * availability through `assetTransferMethod` alone — there is no per-asset proxy override.
 */
function resolveTransferMethods(asset: X402AssetInfo): readonly (string | undefined)[] {
  return [asset.assetTransferMethod];
}

function includeEntry(options: InflowAcceptsOptions, scheme: PaymentScheme, network: string): boolean {
  if (options.schemes !== undefined && !options.schemes.includes(scheme)) return false;
  if (options.networks !== undefined && !options.networks.includes(network)) return false;
  return true;
}

/**
 * `'USD'` is a wildcard that matches any stablecoin asset configured for the seller (USDC, USDT, PYUSD, …); any other
 * value is matched verbatim against `X402AssetInfo.currency`.
 */
function currencyMatches(assetCurrency: string, target: string): boolean {
  if (target === 'USD') return true;
  return assetCurrency === target;
}

interface ParsedAmount {
  /** Integer part with no leading zeros (`'0'` for empty). */
  integer: string;
  /** Decimal-point digits as typed, unpadded. Empty string when no decimal part. */
  fraction: string;
  /** Currency embedded in the input, or `undefined` for the bare form. */
  embeddedCurrency: string | undefined;
}

function normalizePrice(input: PriceSpec | string): PriceSpec {
  return typeof input === 'string' ? { amount: input } : input;
}

/**
 * Parse one of the three accepted price-amount string forms. Does not resolve the final currency — that's
 * `parsePriceSpec`'s job once it's reconciled the embedded currency (if any) against `PriceSpec.currency`.
 */
function parsePriceAmount(input: string): ParsedAmount {
  let match = PRICE_USD_REGEX.exec(input);
  if (match !== null) {
    return {
      integer: stripLeadingZeros(match[1] ?? '0'),
      fraction: match[2] ?? '',
      embeddedCurrency: 'USD',
    };
  }
  match = PRICE_WITH_CURRENCY_REGEX.exec(input);
  if (match !== null) {
    return {
      integer: stripLeadingZeros(match[1] ?? '0'),
      fraction: match[2] ?? '',
      embeddedCurrency: match[3],
    };
  }
  match = PRICE_BARE_REGEX.exec(input);
  if (match !== null) {
    return {
      integer: stripLeadingZeros(match[1] ?? '0'),
      fraction: match[2] ?? '',
      embeddedCurrency: undefined,
    };
  }
  throw new X402PriceParseError(input);
}

/**
 * Resolve a {@link PriceSpec} into a fully-parsed amount plus a final currency. The `currency` field wins on
 * disagreement with any currency embedded in `amount`. Not re-exported from the package barrel; the public surface is
 * {@link inflowAccepts}.
 *
 * @throws {@link X402PriceParseError} When neither side provides a currency or the input is unparseable.
 * @internal
 */
export function parsePriceSpec(price: PriceSpec): {
  amount: ParsedAmount;
  currency: string;
} {
  const amount = parsePriceAmount(price.amount);
  const resolvedCurrency = price.currency ?? amount.embeddedCurrency;
  if (resolvedCurrency === undefined) {
    throw new X402PriceParseError(`${price.amount} (no currency in amount and no currency field supplied)`);
  }
  return { amount, currency: resolvedCurrency };
}

/**
 * Convert a price-amount string into an atomic-unit string for an asset with `decimals` decimal places (multiply by `10
 * ** decimals`). Pure string math — no `Number` or `BigInt` precision loss. Not re-exported from the package barrel;
 * the public surface is {@link inflowAccepts}, which calls this under the hood.
 *
 * @throws {@link X402PriceParseError} On unparseable input or when converting to `decimals` would truncate a non-zero
 *   digit.
 * @internal
 */
export function toAtomicAmount(amount: string, decimals: number): string {
  const parsed = parsePriceAmount(amount);
  return factorParsed(parsed, decimals, amount);
}

function factorParsed(parsed: ParsedAmount, decimals: number, rawForErrorMessage: string): string {
  const fractionPlaces = parsed.fraction.length;
  // Combined string: integer * 10**fractionPlaces + fraction.
  const combined = stripLeadingZeros(`${parsed.integer}${parsed.fraction}`);
  if (decimals === fractionPlaces) return combined;
  if (decimals > fractionPlaces) {
    return `${combined}${'0'.repeat(decimals - fractionPlaces)}`;
  }
  // decimals < fractionPlaces: drop trailing digits (must be zero).
  const drop = fractionPlaces - decimals;
  const trimmed = combined.slice(0, -drop);
  const dropped = combined.slice(-drop);
  if (!/^0*$/u.test(dropped)) {
    throw new X402PriceParseError(
      `${rawForErrorMessage} (cannot be expressed in ${decimals.toString()} decimals without truncation)`,
    );
  }
  return trimmed.length === 0 ? '0' : trimmed;
}

function stripLeadingZeros(s: string): string {
  const stripped = s.replace(/^0+/u, '');
  return stripped.length === 0 ? '0' : stripped;
}
