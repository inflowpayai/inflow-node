// Public barrel for `@inflowpayai/mpp-seller`. Anything not re-exported here is internal. Single root export — there is
// no `./server` subpath; the foundation `Mppx` server handler is re-exported here so a single import gives both the
// handler and the InFlow method: `import { Mppx, inflow } from '@inflowpayai/mpp-seller'`.

export { inflow, tempo } from './methods.server.js';

export { inflowCharges, inflowChargesNodeListener } from './compose.server.js';
export type { InflowChargePrice } from './compose.server.js';

export { createConfigClient } from './config-client.js';
export type { InflowConfigClient } from './config-client.js';

export { MppRedeemProblemError, MppUnsupportedCurrencyError } from './errors.js';

export type { InflowSellerParameters, LoadedConfig, TempoSellerParameters } from './types.js';

export type { Environment, MppCurrencyRail, MppProblemDetail, MppReceipt } from '@inflowpayai/mpp';

// The foundation server handler + helpers. `Mppx.create({ methods: [inflow(...)], secretKey })` owns challenge minting
// and HMAC binding; `Expires` builds per-charge `expires` timestamps; `Receipt` is re-exported for the manual path.
export { Mppx, Expires } from 'mppx/server';
export { Receipt } from 'mppx';
