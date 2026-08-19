// Public barrel for `@inflowpayai/mpp`. Anything not re-exported here is internal.

export {
  CACHE_CONTROL,
  CREDENTIAL_AUTHORIZATION_ID,
  CREDENTIAL_TRANSACTION_ID,
  ENDPOINTS,
  HEADERS,
  INTENT_CHARGE,
  INTENT_SUBSCRIPTION,
  METHOD_INFLOW,
  METHOD_TEMPO,
  PROBLEM_TYPE_BASE,
  PROBLEM_TYPES,
  SCHEME_PAYMENT,
  readHeader,
  readHeaderAll,
  transactionPath,
  subscriptionAuthorizationPath,
} from './constants.js';
export type { HeaderBag } from './constants.js';

export { resolveBaseUrl } from './environment.js';
export type { Environment, ResolveBaseUrlOptions } from './environment.js';

export { InflowApiError, MppCodecError } from './errors.js';
export type { InflowApiErrorInit } from './errors.js';

export {
  canonicalize,
  decode,
  decodeCredential,
  decodeReceipt,
  encode,
  encodeCredential,
  padBase64Url,
  parseChallengeHeader,
  parseChallengeHeaders,
  renderChallengeHeader,
} from './codec.js';

export { InflowHttpClient, MppClient } from './http-client.js';
export type {
  InflowAnonymousClientOptions,
  InflowBearerClientOptions,
  InflowClientOptions,
  MppRequestOptions,
  RequestOptions,
} from './http-client.js';

export {
  charge,
  inflow,
  inflowChargeRequestSchema,
  inflowCredentialPayloadSchema,
  inflowSubscriptionRequestSchema,
  subscription,
  tempo,
  tempoCharge,
  tempoChargeRequestSchema,
  tempoCredentialPayloadSchema,
} from './methods.js';

export {
  subscriptionOptionFingerprint,
  subscriptionOptionFingerprints,
  type SubscriptionOptionFingerprint,
} from './subscription-option.js';
export type {
  InflowChargeRequestInput,
  InflowCredentialPayloadInput,
  InflowSubscriptionRequestInput,
  TempoChargeRequestInput,
  TempoCredentialPayloadInput,
} from './methods.js';

export type {
  CurrencyCode,
  InflowChallengeRequest,
  InflowPaymentOptions,
  MppChallenge,
  MppBroadcastRequest,
  MppBroadcastResponse,
  MppConfigResponse,
  MppCredential,
  MppCredentialRequest,
  MppCurrencyRail,
  MppFeatureFlags,
  MppIntentLabel,
  MppIntentCurrencyRails,
  MppMethodConfig,
  MppMethodLabel,
  MppProblemDetail,
  MppRailLabel,
  MppReceipt,
  MppReplayPolicy,
  MppSupportedIntent,
  MppSupportedKind,
  MppSupportedRail,
  MppSupportedResponse,
  MppTransactionRequest,
  MppTransactionResponse,
  MppTransactionState,
  MppValidateRequest,
  MppValidateResponse,
  SubscriptionPeriodLabel,
  SubscriptionAuthorizationRequest,
  SubscriptionAuthorizationResponse,
  TempoChallengeRequest,
  TempoCredentialPayload,
  TempoMethodDetails,
} from './types.js';

// Re-exported from the foundation SDK because the `inflow` definition and any future sibling intent (`session`) are
// authored with these. The per-side packages own the `Mppx` re-export (see the first-party-SDK pattern); core only
// surfaces the method-authoring primitives.
export { Method, z } from 'mppx';
