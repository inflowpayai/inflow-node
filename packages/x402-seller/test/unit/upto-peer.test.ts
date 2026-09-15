import { describe, expect, it, vi } from 'vitest';

import { inflowSchemeRegistrations } from '../../src/index.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';
import { UPTO_CONFIG } from '../fixtures/upto-config.js';

vi.mock('@x402/evm/upto/server', () => {
  throw new Error('Optional peer unavailable');
});

describe('optional upto peer', () => {
  it('does not load the EVM peer for fixed-price registrations', async () => {
    expect(await inflowSchemeRegistrations(fakeSellerClient(UPTO_CONFIG))).toHaveLength(2);
  });

  it('reports how to install the peer when upto was selected', async () => {
    await expect(inflowSchemeRegistrations(fakeSellerClient(UPTO_CONFIG), { schemes: ['upto'] })).rejects.toThrow(
      'Install the optional peer @x402/evm@^2.22.0',
    );
  });
});
