export interface MppPaymentAmount {
  amount?: string;
  currency?: string;
}

/**
 * Interpret CARD and Stripe USD cents as decimal dollars without changing the wire request. Other methods retain their
 * advertised units; token decimals are not inferred. This reads amount fields, not payment eligibility or challenge
 * validity.
 */
export function readMppPaymentAmount(method: string, request: unknown): MppPaymentAmount {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return {};
  const amount = 'amount' in request && typeof request.amount === 'string' ? request.amount : undefined;
  const currency = 'currency' in request && typeof request.currency === 'string' ? request.currency : undefined;
  if ((method === 'card' || method === 'stripe') && currency === 'usd') {
    if (amount === undefined || amount === '' || /\D/.test(amount)) return { currency: 'USD' };
    const digits = BigInt(amount).toString().padStart(3, '0');
    return { amount: `${digits.slice(0, -2)}.${digits.slice(-2)}`, currency: 'USD' };
  }
  return {
    ...(amount === undefined ? {} : { amount }),
    ...(currency === undefined ? {} : { currency }),
  };
}
