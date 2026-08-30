export type TapVerificationErrorCode =
  | 'CONTENT_DIGEST_INVALID'
  | 'KEY_NOT_FOUND'
  | 'KEY_RETRIEVAL_FAILED'
  | 'NONCE_REPLAYED'
  | 'SIGNATURE_EXPIRED'
  | 'SIGNATURE_INPUT_INVALID'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_LIFETIME_INVALID'
  | 'SIGNATURE_NOT_YET_VALID';

export class TapVerificationError extends Error {
  readonly code: TapVerificationErrorCode;

  constructor(code: TapVerificationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TapVerificationError';
    this.code = code;
  }
}
