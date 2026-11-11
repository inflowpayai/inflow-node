import type { SettleResponse } from '../types.js';

export const INFLOW_TRANSACTION = 'inflow-transaction';

/** Read the seller-accessible InFlow Transaction UUID without substituting the settlement reference. */
export function getInflowTransactionId(result: Pick<SettleResponse, 'success' | 'extensions'>): string | undefined {
  if (!result.success) return undefined;
  const extension = result.extensions?.[INFLOW_TRANSACTION];
  if (extension === null || typeof extension !== 'object' || !('info' in extension)) return undefined;
  const info = extension.info;
  if (info === null || typeof info !== 'object' || !('transactionId' in info)) return undefined;
  return typeof info.transactionId === 'string' &&
    info.transactionId.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(info.transactionId)
    ? info.transactionId
    : undefined;
}
