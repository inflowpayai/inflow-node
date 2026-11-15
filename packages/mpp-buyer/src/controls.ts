import { Currency } from 'mppx';

import type { CardBuyerParameters, InflowChargeBuyerParameters, TempoBuyerParameters } from './types.js';

function decimal(value: string): string {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('Payment limits require non-negative decimal amounts.');
  return value;
}

function atomic(value: string, decimals: number): bigint {
  const [whole = '', fraction = ''] = decimal(value).split('.');
  const significantFraction = fraction.replace(/0+$/, '');
  if (significantFraction.length > decimals) throw new Error('Payment limit exceeds the currency precision.');
  return BigInt(whole + significantFraction.padEnd(decimals, '0'));
}

function exceeds(amount: string, limit: string): boolean {
  decimal(amount);
  const precision = Math.max(amount.split('.')[1]?.length ?? 0, limit.split('.')[1]?.length ?? 0);
  return atomic(amount, precision) > atomic(limit, precision);
}

function assertAmount(amount: string, limit: string | undefined): void {
  if (limit !== undefined && exceeds(amount, limit)) throw new Error('MPP charge amount exceeds maxAmount.');
}

function assertAtomicAmount(amount: string, limit: bigint | undefined): void {
  if (limit !== undefined && BigInt(amount) > limit) throw new Error('MPP charge amount exceeds maxAtomicAmount.');
}

function atomicLimit(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error('maxAtomicAmount requires a non-negative integer.');
  return BigInt(value);
}

/** @internal */
export function inflowControls(parameters: InflowChargeBuyerParameters) {
  const { maxAmount } = parameters;
  const currencies = parameters.currencies ? [...parameters.currencies] : undefined;
  const recipients = parameters.expectedRecipients ? [...parameters.expectedRecipients] : undefined;
  if (maxAmount !== undefined) {
    decimal(maxAmount);
    if (currencies === undefined) throw new Error('maxAmount requires currencies.');
  }
  return (request: { amount: string; currency: string; recipient?: string | undefined }) => {
    if (currencies && !currencies.includes(request.currency)) throw new Error('MPP charge currency is not allowed.');
    if (recipients && (!request.recipient || !recipients.includes(request.recipient))) {
      throw new Error('MPP charge recipient is not allowed.');
    }
    assertAmount(request.amount, maxAmount);
  };
}

/** @internal */
export function cardControls(parameters: CardBuyerParameters) {
  const maxAmount = parameters.maxAmount === undefined ? undefined : atomic(parameters.maxAmount, 2);
  const maxAtomicAmount = atomicLimit(parameters.maxAtomicAmount);
  return (request: { amount: string }) => {
    assertAtomicAmount(request.amount, maxAmount);
    assertAtomicAmount(request.amount, maxAtomicAmount);
  };
}

/** @internal */
export function tempoControls(parameters: TempoBuyerParameters) {
  const { maxAmount, decimals } = parameters;
  const currencies = parameters.currencies ? [...parameters.currencies] : undefined;
  const chains = parameters.allowedChainIds ? [...parameters.allowedChainIds] : undefined;
  const recipients = parameters.expectedRecipients?.map((address) => address.toLowerCase());
  const maxAtomicAmount = atomicLimit(parameters.maxAtomicAmount);
  if (decimals !== undefined && (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)) {
    throw new Error('Currency decimals must be an integer from 0 to 255.');
  }
  if (chains?.some((chain) => !Number.isSafeInteger(chain) || chain < 0)) throw new Error('Invalid allowed chain ID.');
  if (maxAmount !== undefined || maxAtomicAmount !== undefined) {
    if (currencies === undefined) throw new Error('Tempo amount limits require currencies.');
  }
  if (maxAmount !== undefined) {
    decimal(maxAmount);
    for (const currency of currencies ?? []) {
      const precision = typeof currency === 'string' ? decimals : currency.decimals;
      if (precision === undefined) throw new Error('maxAmount requires currency decimals.');
      atomic(maxAmount, precision);
    }
  }
  return (request: {
    amount: string;
    currency?: string | undefined;
    recipient?: string | undefined;
    methodDetails?: { chainId?: number | undefined; splits?: readonly { recipient: string }[] | undefined } | undefined;
  }) => {
    const chainId = request.methodDetails?.chainId;
    // Managed signing happens on the server; an absent chain cannot be inferred from a local wallet.
    if (chains && (chainId === undefined || !chains.includes(chainId)))
      throw new Error('MPP charge chain is not allowed.');
    const matched =
      currencies && request.currency
        ? Currency.find(
            chainId === undefined ? currencies.filter((currency) => typeof currency === 'string') : currencies,
            request.currency,
            {
              ...(chainId === undefined ? {} : { chainId }),
              ...(decimals === undefined ? {} : { decimals }),
            },
          )
        : undefined;
    if (currencies && !matched) throw new Error('MPP charge currency is not allowed.');
    if (recipients) {
      for (const recipient of [
        request.recipient,
        ...(request.methodDetails?.splits ?? []).map((split) => split.recipient),
      ]) {
        if (!recipient || !recipients.includes(recipient.toLowerCase()))
          throw new Error('MPP charge recipient is not allowed.');
      }
    }
    assertAtomicAmount(request.amount, maxAtomicAmount);
    if (maxAmount !== undefined) {
      if (matched?.decimals === undefined) throw new Error('maxAmount requires currency decimals.');
      assertAtomicAmount(request.amount, atomic(maxAmount, matched.decimals));
    }
  };
}

/** @internal */
export function accepts(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}
