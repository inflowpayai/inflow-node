import type { TapMiddleware, TapVerifier } from './types.js';

export function createTapMiddleware(verifier: TapVerifier): TapMiddleware {
  return async (request, next) => next(await verifier.verify(request));
}
