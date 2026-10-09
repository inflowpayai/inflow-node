import { Transport } from 'mppx/server';

/** Pass to Mppx.create({ transport }) to return server failures without a payment challenge. */
export function paymentHttpTransport(): Transport.Http {
  const transport = Transport.http();
  return {
    ...transport,
    respondChallenge(options) {
      // mppx's HTTP transport attaches a fresh challenge even when the error status is 500.
      if (options.error !== undefined && options.error.status >= 500) {
        return Response.json(options.error.toProblemDetails(), {
          status: options.error.status,
          headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
        });
      }
      return transport.respondChallenge(options);
    },
  };
}
