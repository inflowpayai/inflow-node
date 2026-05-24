/**
 * Thrown by `inflowAccepts` when a price string doesn't match any accepted form. See {@link PriceSpec.amount} for the
 * grammar.
 */
export class X402PriceParseError extends Error {
  /** The original input that failed parsing. */
  readonly input: string;
  /** @param input - The {@link PriceSpec.amount} value that failed parsing. */
  constructor(input: string) {
    super(
      `Invalid price "${input}"; expected "$<dollars>(.<decimals>)?", ` +
        `"<amount> <CURRENCY>", or bare "<amount>" (up to 8 decimal places).`,
    );
    this.name = 'X402PriceParseError';
    this.input = input;
  }
}
