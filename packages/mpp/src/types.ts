// MPP wire-shape types and InFlow MPP REST DTOs. Kept byte-compatible with the server models under
// `ai.inflowpay.mpp.model` and `ai.inflowpay.api.v1`. Enum-valued fields are typed as their wire label (the Java
// `@JsonValue`), with an open `(string & {})` branch so the SDK can route forward-compatible values the server may add
// without a type-level break. Amounts are decimal strings (the server serialises `BigDecimal` as a plain string), never
// JS `number`.

/** Wire label of a payment method — the `MppMethodId` `@JsonValue`. */
export type MppMethodLabel = 'inflow' | 'tempo' | (string & {});

/** Wire label of an intent — the `MppIntent` `@JsonValue`. `'charge'` is the only intent today. */
export type MppIntentLabel = 'charge' | (string & {});

/**
 * Settlement rail label as carried on the wire — the server's `MppRail` `@JsonValue` (e.g. `'balance'`). The server's
 * `@JsonCreator` accepts either the label or the uppercase enum name on input.
 */
export type MppRailLabel = 'balance' | 'blockchain' | 'instrument' | (string & {});

/**
 * ISO-4217-style currency code carried on the wire (e.g. `'USDC'`, `'USDT'`, `'PYUSD'`). Typed as an open string; the
 * SDK does not enumerate the server's `Currency` set.
 */
export type CurrencyCode = string;

/**
 * The MPP challenge a seller emits in a `WWW-Authenticate: Payment` header and a buyer parses out of a 402. Mirrors the
 * server's `MppChallenge`. `request` is a base64url-JCS blob the SDK keeps opaque. Every field the seller sent —
 * including the optional `opaque` correlation blob — MUST be preserved verbatim and echoed back inside the credential's
 * `challenge` so the seller can recompute its HMAC binding (slot 6 of the binding input is `opaque`); dropping it
 * breaks verification.
 */
export interface MppChallenge {
  /**
   * Challenge identifier, HMAC-bound by the seller's issuer (mppx, or InFlow's native issuer) over the challenge
   * fields. Required. This SDK does not verify the binding — verification is the challenge issuer's job with the
   * issuer's secret — but it MUST echo `id` (and the fields it binds, including `opaque`) unchanged so that
   * verification can succeed.
   */
  id: string;
  /** Realm identifying the protection space. Required. */
  realm: string;
  /** Method that minted this challenge (e.g. `'inflow'`). Required. */
  method: MppMethodLabel;
  /** Intent the challenge offers (e.g. `'charge'`). Required. */
  intent: MppIntentLabel;
  /** Base64url-JCS of the method-specific challenge request object (for `inflow`, an {@link InflowChallengeRequest}). */
  request: string;
  /** RFC 3339 timestamp when this challenge expires. */
  expires?: string;
  /** Display-only text. Clients must not use it for authorization decisions. RFC 7235 quoted-string on the wire. */
  description?: string;
  /**
   * RFC 9530 Content-Digest a foundation-SDK mutating route may bind into the challenge. Carried through verbatim on
   * the wire; this SDK neither computes nor verifies it (body-digest enforcement, where it exists, is owned by the
   * foundation SDK / server, not this package).
   */
  digest?: string;
  /**
   * Base64url-encoded JSON correlation blob the issuer may bind into the challenge (slot 6 of the HMAC binding input).
   * Carried through verbatim: the SDK never reads, decodes, or mutates it — it only preserves it so the seller can
   * recompute its binding. Dropping this field silently breaks the seller's HMAC verification, so it MUST round-trip
   * from the parsed challenge into the credential's echoed `challenge`.
   */
  opaque?: string;
}

/**
 * The method-specific request object carried (base64url-JCS) in {@link MppChallenge.request} for the `inflow` method.
 * Mirrors the server's `InflowChallengeRequest`. The rail/instrument selectors are nested under `methodDetails`, and
 * there are no blockchain/wallet fields; `amount` is a decimal string normalised without trailing zeros. The nested
 * object JCS-encodes deterministically (sorted keys), preserving byte-parity with the server's canonical encoding.
 */
export interface InflowChallengeRequest {
  /** Decimal amount string, canonicalised without trailing zeros (e.g. `'10'`, `'1.5'`). Required. */
  amount: string;
  /** Currency the seller requests payment in. Required. */
  currency: CurrencyCode;
  /** Recipient userId (UUID). The server defaults it to the authenticated seller when minting. */
  recipient?: string;
  /** Rail/instrument selectors the seller pinned, derived from the charge currency via config `currencyRails`. */
  methodDetails?: {
    /** Target settlement rail. */
    rail?: MppRailLabel;
    /** Funding instrument id (UUID); only meaningful for `rail: 'instrument'`. */
    instrumentId?: string;
  };
}

/** Optional Tempo method details carried inside a `tempo` charge request. */
export interface TempoMethodDetails {
  /** Tempo EVM chain id. */
  chainId?: number;
  /** Whether the server pays transaction fees. The current InFlow seller/server path supports only `false`. */
  feePayer?: boolean;
  /** Optional bytes32 memo for the primary transfer. */
  memo?: string;
  /** Additional split recipients paid atomically by the Tempo transaction. */
  splits?: {
    /** Split amount in base units. */
    amount: string;
    /** Optional bytes32 memo for the split transfer. */
    memo?: string;
    /** Split recipient address. */
    recipient: string;
  }[];
  /** Supported non-zero submission modes for this challenge. */
  supportedModes?: ('pull' | 'push')[];
}

/**
 * The method-specific request object for the `tempo` method. Amount is a base-unit integer string, `currency` is a
 * TIP-20 token address, and `recipient` is a Tempo address.
 */
export interface TempoChallengeRequest {
  /** Amount in base units. Required on the wire. */
  amount: string;
  /** TIP-20 token address. Required on the wire. */
  currency?: string;
  /** Recipient Tempo address. Required on the wire. */
  recipient?: string;
  /** Display-only payment description. */
  description?: string;
  /** Merchant reference, such as an invoice id. */
  externalId?: string;
  /** Tempo-specific challenge parameters. */
  methodDetails?: TempoMethodDetails;
}

/** Tempo credential payload for pull, push, and zero-amount proof flows. */
export type TempoCredentialPayload = (
  | { type: 'transaction'; signature: string }
  | { type: 'hash'; hash: string }
  | { type: 'proof'; signature: string }
) & { transactionId?: string };

/**
 * The buyer's MPP credential, sent base64url-encoded in `Authorization: Payment <credential>`. Mirrors the server's
 * `MppCredential`. The embedded `challenge` is echoed verbatim so the server can read its fields and correlate by the
 * payload `transactionId`; the server does not re-verify the challenge's HMAC binding (that is the foundation SDK's).
 */
export interface MppCredential {
  /** The HMAC-bound challenge this credential redeems. Required. */
  challenge: MppChallenge;
  /**
   * Method-specific proof payload (rail-specific, e.g. `approvalId` for balance). Also carries the server-minted
   * `transactionId` correlation key (see `CREDENTIAL_TRANSACTION_ID`) the server reads back on redeem. Required.
   */
  payload: Record<string, unknown>;
  /** Payer identity per the MPP spec — a DID, blockchain address, or account identifier. Required. */
  source: string;
}

/**
 * The receipt a seller returns base64url-encoded in `Payment-Receipt` after a successful redemption. Mirrors the
 * server's `MppReceipt`.
 */
export interface MppReceipt {
  /** Challenge id this receipt responds to, when supplied by the payment method. */
  challengeId?: string;
  /** Payment method identifier (e.g. `'inflow'`). Required. */
  method: MppMethodLabel;
  /** Method-specific reference (tx hash, PaymentIntent id, ledger entry id, etc.). Required. */
  reference: string;
  /** Settlement details recorded by the payment method. */
  settlement?: {
    /** Settled amount as a decimal string in the payment method's units. Required. */
    amount: string;
    /** Settled currency or asset identifier. Required. */
    currency: string;
  };
  /** Settlement status. Only `'success'` is emitted today. Required. */
  status: 'success';
  /** RFC 3339 timestamp of settlement. Required. */
  timestamp: string;
}

/**
 * RFC 9457 problem detail. Mirrors the server's `MppProblemDetail`. `type` is a {@link PROBLEM_TYPE_BASE} URI; `status`
 * is always `402` for MPP payment-flow problems.
 */
export interface MppProblemDetail {
  /** URI identifying the problem type (under `https://paymentauth.org/problems/`). Required. */
  type: string;
  /** Short, human-readable summary of the problem. Required. */
  title: string;
  /** HTTP status code. Always `402` for MPP payment-flow problems. Required. */
  status: number;
  /** Human-readable explanation specific to this occurrence. Required. */
  detail: string;
  /** Additional problem-type-specific context. */
  extensions?: Record<string, unknown>;
}

/** Bootstrap signals influencing SDK behaviour; mirrors the server's `MppConfigResponse.FeatureFlags`. */
export interface MppFeatureFlags {
  /** Whether the server honors `Idempotency-Key` headers on mutating endpoints. Required. */
  idempotencyKeyEnabled: boolean;
}

/**
 * Per-currency rail capability advertised in config; mirrors one entry of the server's `currencyRails` map. The SDK
 * consumes this to derive the challenge rail from the charge currency (crypto → `balance`, fiat → `instrument`).
 */
export interface MppCurrencyRail {
  /** Settlement rail for this currency — `'balance'` (crypto) or `'instrument'` (fiat). Required. */
  rail: MppRailLabel;
  /** Whether a funding `instrumentId` is needed; present only for `rail: 'instrument'`. */
  instrumentId?: 'optional' | 'required';
}

/** Per-method capability advertised in config; mirrors the server's `MppConfigResponse.MppMethodConfig`. */
export interface MppMethodConfig {
  /** Stable method identifier (e.g. `'inflow'`). Required. */
  id: MppMethodLabel;
  /** Human-readable method label. Required. */
  label: string;
  /**
   * Method-specific extras. For `inflow`, carries `currencyRails`: a map of currency code → rail capability the SDK
   * uses to derive the rail. A currency absent here (or from `supportedCurrencies`) yields no header for this method.
   */
  methodDetails?: { currencyRails?: Record<string, MppCurrencyRail> } & Record<string, unknown>;
  /** Currencies this method can accept. Required. */
  supportedCurrencies: CurrencyCode[];
  /** Intents this method can offer. Required. */
  supportedIntents: MppIntentLabel[];
}

/** Replay-protection ownership; mirrors the server's `MppConfigResponse.ReplayPolicy`. */
export interface MppReplayPolicy {
  /** Party responsible for replay protection. Only `'psp'` is offered today. Required. */
  managedBy: 'psp' | (string & {});
}

/**
 * Response body for `GET /v1/mpp/config`. Mirrors the server's `MppConfigResponse`. The SDK caches this on init. The
 * HMAC secret is never present.
 */
export interface MppConfigResponse {
  /** Bootstrap feature flags. Required. */
  featureFlags: MppFeatureFlags;
  /** Who owns replay protection for credential redemptions. Required. */
  replayPolicy: MppReplayPolicy;
  /** The authenticated seller's user id; the SDK uses it as the challenge recipient. Required. */
  sellerId: string;
  /** Per-method capabilities, unioned across the PSP's registered methods. Required. */
  supportedMethods: MppMethodConfig[];
}

/** Request body for `POST /v1/mpp/redeem`. Mirrors the server's `MppRedeemRequest`. */
export interface MppRedeemRequest {
  /** The buyer's credential to verify and settle. Required. */
  credential: MppCredential;
}

/**
 * Response body for `POST /v1/mpp/redeem`. Always HTTP 200; success vs failure is signalled in the body. Mirrors the
 * server's `MppRedeemResponse`.
 */
export interface MppRedeemResponse {
  /** Settlement receipt; populated only on success. */
  receipt?: MppReceipt;
  /** Base64url-encoded {@link MppReceipt} for the `Payment-Receipt` response header; populated only on success. */
  receiptHeader?: string;
  /** RFC 9457 problem detail; populated only on failure. */
  problem?: MppProblemDetail;
}

/**
 * Method-specific payment options for the `inflow` method, sent in {@link MppTransactionRequest.options}. Mirrors the
 * server's `InflowPaymentOptions`. The buyer reads the rail from the seller's challenge — it does not choose it — so
 * the only buyer-supplied extra is `instrumentId` (for instrument-rail challenges).
 */
export interface InflowPaymentOptions {
  /** Funding instrument id (UUID), for an instrument-rail challenge. */
  instrumentId?: string;
}

/** Request body for `POST /v1/transactions/mpp`. Mirrors the server's `MppTransactionRequest`. */
export interface MppTransactionRequest {
  /** The challenge the buyer parsed out of the seller's 402 `WWW-Authenticate` header. Required. */
  challenge: MppChallenge;
  /** Method-specific payment options, decoded by `challenge.method`. For `inflow`, an {@link InflowPaymentOptions}. */
  options: InflowPaymentOptions | Record<string, unknown>;
}

/** Buyer-side fulfilment state of an MPP transaction; mirrors the server's `MppTransactionResponse.state` union. */
export type MppTransactionState = 'expired' | 'failed' | 'pending' | 'ready';

/**
 * Response body for `POST /v1/transactions/mpp` and `GET /v1/transactions/{id}/mpp`. Mirrors the server's
 * `MppTransactionResponse`. Which optional fields are populated depends on `state` (see each field).
 */
export interface MppTransactionResponse {
  /** Current fulfilment state. Required. */
  state: MppTransactionState;
  /** Approval id backing this transaction. Populated when `state` is `'pending'`. */
  approvalId?: string;
  /** Base64url-encoded {@link MppCredential}. Populated when `state` is `'ready'`. */
  credential?: string;
  /** RFC 3339 challenge expiry. Populated when `state` is `'ready'`. */
  expires?: string;
  /** Method-specific next-step data (wallet address, instructions, …). Populated when `state` is `'pending'`. */
  methodSpecific?: Record<string, unknown>;
  /** Failure detail. Populated when `state` is `'failed'`. */
  problem?: MppProblemDetail;
  /** Suggested poll interval, in seconds. Populated when `state` is `'pending'`. */
  retryAfterSeconds?: number;
  /** Parent transaction id (UUID). Null only on the terminal `'expired'` state. */
  transactionId?: string;
}

/**
 * One settlement rail and the currencies the buyer can pay on it, within an intent. Mirrors
 * `MppSupportedResponse.Rail`.
 */
export interface MppSupportedRail {
  /** Settlement rail. Required. */
  rail: MppRailLabel;
  /** Currencies the buyer can pay on this rail. Required. */
  currencies: CurrencyCode[];
}

/**
 * One intent and the rails (each with its currencies) the buyer can fulfil it on. Mirrors
 * `MppSupportedResponse.Intent`.
 */
export interface MppSupportedIntent {
  /** Payment intent. Required. */
  intent: MppIntentLabel;
  /** Settlement rails supported for this intent, each with its currencies. Required. */
  rails: MppSupportedRail[];
}

/**
 * One payment method and the intents (each with rails + currencies) the buyer can fulfil. Mirrors
 * `MppSupportedResponse.Kind`.
 */
export interface MppSupportedKind {
  /** Payment method. Required. */
  method: MppMethodLabel;
  /** Intents this method supports, each with its rails and currencies. Required. */
  intents: MppSupportedIntent[];
}

/**
 * Response body for `GET /v1/transactions/mpp-supported`. Mirrors the server's `MppSupportedResponse`: the methods the
 * authenticated buyer can pay with, broken down by intent and settlement rail with the currencies available on each.
 */
export interface MppSupportedResponse {
  /** The methods the buyer can pay with. Required. */
  kinds: MppSupportedKind[];
}
