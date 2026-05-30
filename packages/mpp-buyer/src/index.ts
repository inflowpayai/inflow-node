// Public barrel for `@inflowpayai/mpp-buyer`. Anything not re-exported here is internal.

export { inflow, inflowContextSchema } from './methods.client.js';

export type { FulfilOptions, InflowBuyerParameters } from './types.js';

export {
  MppMalformedCredentialError,
  MppPaymentCancelledError,
  MppPaymentExpiredError,
  MppPaymentFailedError,
  MppPaymentTimeoutError,
} from './errors.js';

// Re-export the `inflow` payment-options type and the three auth-option shapes (referenced by `InflowBuyerParameters`)
// from core so consumers type construction and per-call `context` without a second dependency on `@inflowpayai/mpp`.
export type {
  Environment,
  InflowAnonymousClientOptions,
  InflowBearerClientOptions,
  InflowClientOptions,
  InflowPaymentOptions,
  MppCredential,
} from '@inflowpayai/mpp';

// Single import gives both the foundation client and the InFlow method: `import { Mppx, inflow } from
// '@inflowpayai/mpp-buyer'`. `Receipt` is re-exported for the manual path (`Receipt.fromResponse`).
export { Mppx } from 'mppx/client';
export { Receipt } from 'mppx';
