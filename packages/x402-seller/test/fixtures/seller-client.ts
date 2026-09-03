import type { InflowSellerClient } from '../../src/seller-client.js';
import { SAMPLE_CONFIG } from './config-response.js';

export function fakeSellerClient(): InflowSellerClient {
  return {
    config: () => Promise.resolve(SAMPLE_CONFIG),
    refreshConfig: () => Promise.reject(new Error('refreshConfig: not stubbed')),
    refreshSupported: () => Promise.reject(new Error('refreshSupported: not stubbed')),
    getSignerAddresses: () => Promise.reject(new Error('getSignerAddresses: not stubbed')),
  };
}
