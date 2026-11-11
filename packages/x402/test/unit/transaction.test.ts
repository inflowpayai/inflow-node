import { describe, expect, it } from 'vitest';

import { getInflowTransactionId, INFLOW_TRANSACTION } from '../../src/extensions/index.js';

const transactionId = '22222222-2222-4222-8222-222222222222';

describe('settlement transaction correlation', () => {
  it('reads the seller transaction without changing other settlement fields', () => {
    const extension = Object.freeze({ info: Object.freeze({ transactionId }), schema: { type: 'object' } });
    const response = Object.freeze({
      success: true,
      transaction: '0xsettlement',
      network: 'eip155:8453',
      extensions: Object.freeze({ [INFLOW_TRANSACTION]: extension, unrelated: { info: 'preserved' } }),
    });
    expect(getInflowTransactionId(response)).toBe(transactionId);
    expect(response.transaction).toBe('0xsettlement');
    expect(response.extensions[INFLOW_TRANSACTION]).toBe(extension);
    expect(response.extensions.unrelated).toEqual({ info: 'preserved' });
  });

  it('does not report an identifier for failed settlement', () => {
    expect(
      getInflowTransactionId({ success: false, extensions: { [INFLOW_TRANSACTION]: { info: { transactionId } } } }),
    ).toBeUndefined();
  });

  it('accepts older settlement responses without inferring an identifier', () => {
    const response = { success: true, transaction: transactionId, network: 'inflow:1' };
    expect(getInflowTransactionId(response)).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    false,
    'unexpected',
    {},
    [],
    { info: null },
    { info: 'unexpected' },
    { info: [] },
    { info: {} },
    { info: { transactionId: null } },
    { info: { transactionId: 42 } },
    { info: { transactionId: '' } },
    { info: { transactionId: 'not-a-uuid' } },
    { info: { transactionId: 'x'.repeat(36) } },
    { info: { transactionId: `${transactionId}\n` } },
  ])('ignores absent or malformed correlation metadata: %j', (extension) => {
    expect(getInflowTransactionId({ success: true, extensions: { [INFLOW_TRANSACTION]: extension } })).toBeUndefined();
  });
});
