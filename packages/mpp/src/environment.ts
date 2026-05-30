/**
 * Public InFlow environments addressable by the SDK without an explicit `baseUrl` override. Names and URLs are
 * deliberately identical to `@inflowpayai/x402`'s, so a consumer using both products configures them the same way.
 */
export type Environment = 'production' | 'sandbox';

const URLS: Readonly<Record<Environment, string>> = {
  production: 'https://api.inflowpay.ai',
  sandbox: 'https://sandbox.inflowpay.ai',
};

/** Options consumed by {@link resolveBaseUrl}. */
export interface ResolveBaseUrlOptions {
  /** Selects one of the public environments. Defaults to `'production'`. */
  environment?: Environment;
  /** Override the environment-derived URL entirely. Trailing slashes are stripped. Takes precedence over `environment`. */
  baseUrl?: string;
}

/**
 * Resolve the InFlow API base URL the SDK will issue requests against.
 *
 * @param options - {@link ResolveBaseUrlOptions}. `baseUrl` wins over `environment`. With neither set, falls back to the
 *   production URL.
 * @returns The base URL with any trailing slashes stripped, suitable for appending request paths.
 */
export function resolveBaseUrl(options: ResolveBaseUrlOptions = {}): string {
  if (options.baseUrl !== undefined && options.baseUrl !== '') {
    return options.baseUrl.replace(/\/+$/, '');
  }
  return URLS[options.environment ?? 'production'];
}
