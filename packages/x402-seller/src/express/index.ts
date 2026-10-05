import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import { InflowApiError } from '@inflowpayai/x402';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import type { HTTPTransportContext, x402HTTPResourceServer } from '@x402/core/server';
import { withPrivateCacheControl } from '@x402/core/server';
import type { PaymentPayload, VerifyResponse } from '@x402/core/types';
import { ExpressAdapter, paymentMiddlewareFromHTTPServer } from '@x402/express';
import type { Request, RequestHandler, Response } from 'express';

import { ensurePaymentIdentifier } from '../facilitator.js';
import { replayDigest } from '../replay.js';
import type { PaymentReplayProduct, PaymentReplayResponse, PaymentReplayStore } from '../replay.js';

export type {
  PaymentReplayClaim,
  PaymentReplayProduct,
  PaymentReplayRecord,
  PaymentReplayResponse,
  PaymentReplayStore,
} from '../replay.js';

const DEFAULT_REQUEST_HEADERS = ['accept', 'accept-language', 'accept-encoding', 'content-type'];
const DEFAULT_RESPONSE_HEADERS = [
  'content-type',
  'content-language',
  'content-encoding',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
  'location',
  'vary',
];
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'date',
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'upgrade',
  'trailer',
]);
const BODY_LIMIT = 1024 * 1024;
const CONTROL_RESPONSE_HEADERS = [
  'payment-response',
  'payment-required',
  'settlement-overrides',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'upgrade',
  'trailer',
];

export interface InflowExpressReplayOptions {
  store: PaymentReplayStore;
  /** Trusted seller namespace shared by every route/service using this financial seller, never a request header. */
  scope: string;
  /** Resolve an already authenticated subject; never infer it from an unverified payment. */
  principal(request: Request): string | undefined | Promise<string | undefined>;
  /** Exact request bytes captured by body parsing middleware before this helper is mounted. */
  body(request: Request): Uint8Array | undefined;
  requestHeaders?: readonly string[];
  responseHeaders?: readonly string[];
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

interface ReplayRequest {
  key: string;
  fingerprint: string;
  response: Response;
  payload: PaymentPayload;
  token?: string;
  product?: PaymentReplayProduct;
  completed?: PaymentReplayResponse;
  failure?: { status: number; error: string };
}

/**
 * Mount after authentication and raw-body capture instead of a second payment middleware. The supplied resource server
 * owns route matching, verification and settlement. Only authorization flows and bounded, non-streaming responses are
 * supported. Completed replay still passes the current protected-request and requirement gates.
 */
export function createInflowExpressReplayMiddleware(
  httpServer: x402HTTPResourceServer,
  options: InflowExpressReplayOptions,
): RequestHandler {
  if (options.scope.trim() === '') throw new Error('Replay scope must not be empty');
  const requestHeaders = headerNames([...DEFAULT_REQUEST_HEADERS, ...(options.requestHeaders ?? [])]);
  const responseHeaders = headerNames([...DEFAULT_RESPONSE_HEADERS, ...(options.responseHeaders ?? [])]);
  const requestLimit = byteLimit(options.maxRequestBytes ?? BODY_LIMIT);
  const responseLimit = byteLimit(options.maxResponseBytes ?? BODY_LIMIT);
  const current = new AsyncLocalStorage<ReplayRequest>();
  const middleware = paymentMiddlewareFromHTTPServer(httpServer);

  httpServer.server.onBeforeVerify(async () => {
    const state = current.getStore();
    if (state === undefined) return;
    try {
      const record = await options.store.lookup(state.key, state.fingerprint);
      if (record === 'conflict') return abort(state, 409, 'payment_replay_conflict');
      if (record === undefined) return;
      if (record.state === 'completed') {
        if (record.response.body.byteLength > responseLimit)
          return abort(state, 503, 'payment_replay_response_too_large');
        state.completed = record.response;
        return { abort: true, reason: 'payment_replay_completed' };
      }
      if (record.product === undefined) return abort(state, 409, 'payment_replay_pending');
      return { skip: true, result: record.verification };
    } catch {
      return abort(state, 503, 'payment_replay_storage_unavailable');
    }
  });

  httpServer.server.onAfterVerify(async (context) => {
    const state = current.getStore();
    if (state === undefined || !context.result.isValid) return;
    try {
      if (isSettledVerification(context.result)) return abort(state, 409, 'payment_replay_product_unavailable');
      const verification: VerifyResponse = { ...context.result };
      const claim = await options.store.claim(state.key, state.fingerprint, verification);
      switch (claim.type) {
        case 'owned':
          if (claim.product !== undefined && claim.product.body.byteLength > responseLimit)
            return abort(state, 503, 'payment_replay_response_too_large');
          state.token = claim.token;
          if (claim.product !== undefined) state.product = claim.product;
          return;
        case 'completed':
          if (claim.response.body.byteLength > responseLimit)
            return abort(state, 503, 'payment_replay_response_too_large');
          state.completed = claim.response;
          return { skipHandler: true };
        case 'pending':
          return abort(state, 409, 'payment_replay_pending');
        case 'conflict':
          return abort(state, 409, 'payment_replay_conflict');
      }
    } catch {
      return abort(state, 503, 'payment_replay_storage_unavailable');
    }
  });

  const recordFacilitatorConflict = (error: unknown) => {
    const state = current.getStore();
    if (state !== undefined && error instanceof InflowApiError && error.httpStatus === 409) {
      abort(state, 409, 'payment_replay_conflict_or_pending');
    }
  };
  httpServer.server.onVerifyFailure((context) => {
    recordFacilitatorConflict(context.error);
    return Promise.resolve();
  });
  httpServer.server.onSettleFailure((context) => {
    recordFacilitatorConflict(context.error);
    return Promise.resolve();
  });

  httpServer.server.onBeforeSettle(async (context) => {
    const state = current.getStore();
    if (state === undefined) return;
    if (state.failure !== undefined) return { abort: true, reason: state.failure.error };
    if (state.completed !== undefined) {
      // A concurrent owner can finish between lookup and claim. Never contact the facilitator on that path.
      return { abort: true, reason: 'payment_replay_completed' };
    }
    if (state.token === undefined || context.phase !== 'after-handler') {
      return abort(state, 503, 'payment_replay_unsupported_flow');
    }
    try {
      const transport = context.transportContext as HTTPTransportContext;
      if (transport.responseBody === undefined || transport.responseBody.byteLength > responseLimit) {
        return abort(state, 503, 'payment_replay_response_too_large');
      }
      const observed: PaymentReplayProduct = {
        status: state.response.statusCode,
        headers: selectedResponseHeaders(state.response, responseHeaders),
        body: Uint8Array.from(transport.responseBody),
        paymentPayload: state.payload,
        paymentRequirements: { ...context.requirements },
        declaredExtensions: { ...context.declaredExtensions },
      };
      if (
        state.product !== undefined &&
        replayDigest(state.product.paymentRequirements) !== replayDigest(observed.paymentRequirements)
      ) {
        return abort(state, 409, 'payment_replay_conflict');
      }
      const product = state.product ?? observed;
      if (!(await options.store.stage(state.key, state.token, product))) {
        return abort(state, 503, 'payment_replay_ownership_lost');
      }
      state.product = product;
    } catch {
      return abort(state, 503, 'payment_replay_storage_unavailable');
    }
  });

  return async (request, response, next) => {
    const signature = request.get('payment-signature');
    const legacy = request.get('x-payment');
    const header = signature ?? legacy;
    if (
      header === undefined ||
      !httpServer.requiresPayment({
        adapter: new ExpressAdapter(request),
        path: request.path,
        decodedPath: decodedPath(request.path),
        method: request.method,
      })
    ) {
      await middleware(request, response, next);
      return;
    }
    if (signature !== undefined && legacy !== undefined) {
      sendFailure(response, 400, 'payment_replay_ambiguous_payment_headers');
      return;
    }
    let state: ReplayRequest;
    try {
      const principal = await options.principal(request);
      if (principal === undefined || principal === '') {
        sendFailure(response, 401, 'payment_replay_authentication_required');
        return;
      }
      const captured = options.body(request);
      const length = request.get('content-length');
      if (
        captured === undefined &&
        ((length !== undefined && Number(length) > 0) || request.get('transfer-encoding') !== undefined)
      ) {
        sendFailure(response, 400, 'payment_replay_body_not_captured');
        return;
      }
      const body = captured ?? Buffer.alloc(0);
      if (length !== undefined && Number(length) !== body.byteLength) {
        sendFailure(response, 400, 'payment_replay_body_not_captured');
        return;
      }
      if (body.byteLength > requestLimit) {
        sendFailure(response, 413, 'payment_replay_request_too_large');
        return;
      }
      const decoded = decodePaymentSignatureHeader(header);
      const payload: PaymentPayload = ensurePaymentIdentifier(decoded) as PaymentPayload;
      if (httpServer.server.getPaymentFlow(payload, payload.accepted) !== 'authorization') {
        sendFailure(response, 400, 'payment_replay_unsupported_flow');
        return;
      }
      const entry = payload.extensions?.['payment-identifier'] as { info: { id: string } };
      const url = new URL(`${request.protocol}://${request.get('host') ?? ''}${request.originalUrl}`);
      url.searchParams.sort();
      state = {
        key: replayDigest([options.scope, entry.info.id]),
        fingerprint: replayDigest({
          principal,
          payment: decoded,
          method: request.method,
          resource: url.toString(),
          body: createHash('sha256').update(body).digest('hex'),
          headers: Object.fromEntries(requestHeaders.map((name) => [name, request.get(name) ?? ''])),
        }),
        response,
        payload,
      };
    } catch {
      sendFailure(response, 400, 'payment_replay_invalid_request');
      return;
    }
    try {
      if ((await options.store.lookup(state.key, state.fingerprint)) === 'conflict') {
        sendFailure(response, 409, 'payment_replay_conflict');
        return;
      }
    } catch {
      sendFailure(response, 503, 'payment_replay_storage_unavailable');
      return;
    }
    await current.run(state, async () => {
      const barrier = responseBarrier(response, responseHeaders, responseLimit);
      try {
        await middleware(request, response, (error?: unknown) => {
          if (error !== undefined) {
            state.failure = { status: 503, error: 'payment_replay_handler_failed' };
            response.status(503).end();
            return;
          }
          if (state.product !== undefined) {
            if (state.product.paymentRequirements.amount !== state.product.paymentPayload.accepted.amount) {
              response.setHeader(
                'Settlement-Overrides',
                JSON.stringify({ amount: state.product.paymentRequirements.amount }),
              );
            }
            writeResponse(response, state.product);
            return;
          }
          if (state.token === undefined) {
            state.failure = { status: 400, error: 'payment_replay_payment_not_verified' };
            response.status(400).end();
            return;
          }
          captureWriteHead(response);
          limitHandlerResponse(response, state, responseLimit);
          const flush = response.flushHeaders.bind(response);
          response.flushHeaders = () => {
            state.failure = { status: 503, error: 'payment_replay_streaming_unsupported' };
            flush();
          };
          next();
        });
        const result = privatePaidResponse(await barrier.result);
        if (state.failure !== undefined) {
          barrier.emit(failureResponse(state.failure.status, state.failure.error));
          return;
        }
        if (state.completed !== undefined) {
          barrier.emit(privatePaidResponse(state.completed));
          return;
        }
        if (
          state.token !== undefined &&
          state.product !== undefined &&
          result.headers['payment-response'] !== undefined &&
          result.status < 400
        ) {
          if (!(await options.store.complete(state.key, state.token, result))) {
            barrier.emit(failureResponse(503, 'payment_replay_ownership_lost'));
            return;
          }
        }
        barrier.emit(result);
      } catch {
        barrier.emit(failureResponse(503, 'payment_replay_storage_unavailable'));
      }
    });
  };
}

function abort(state: ReplayRequest, status: number, error: string): { abort: true; reason: string } {
  state.failure = { status, error };
  return { abort: true, reason: error };
}

function decodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function isSettledVerification(result: VerifyResponse): boolean {
  const entry = result.extensions?.['payment-identifier'];
  if (entry === null || typeof entry !== 'object' || !('info' in entry)) return false;
  const info: unknown = entry.info;
  return info !== null && typeof info === 'object' && 'settled' in info && info.settled === true;
}

function headerNames(names: readonly string[]): string[] {
  return [
    ...new Set(
      names.map((name) => {
        const normalized = name.toLowerCase();
        if (!/^[a-z0-9-]+$/u.test(normalized) || FORBIDDEN_HEADERS.has(normalized))
          throw new Error('Unsafe replay header');
        return normalized;
      }),
    ),
  ];
}

function byteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Replay byte limits must be positive integers');
  return value;
}

function selectedResponseHeaders(response: Response, names: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  const connection = String(response.getHeader('connection') ?? '')
    .toLowerCase()
    .split(',')
    .map((name) => name.trim());
  for (const name of [...names, 'payment-response', 'payment-required']) {
    if (connection.includes(name)) continue;
    const value = response.getHeader(name);
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

function privatePaidResponse(value: PaymentReplayResponse): PaymentReplayResponse {
  const policy = value.headers['cache-control'];
  if (value.status >= 400 || value.headers['payment-response'] === undefined || policy === undefined) return value;
  const directives = policy.match(/(?:[^",]|"(?:\\.|[^"\\])*")+/gu)?.map((directive) => directive.trim()) ?? [];
  const retained = directives.filter((directive) => directive.toLowerCase() !== 'public');
  if (retained.length === directives.length) return value;
  return {
    ...value,
    headers: { ...value.headers, 'cache-control': withPrivateCacheControl(retained.join(', ') || null) },
  };
}

function failureResponse(status: number, error: string): PaymentReplayResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: Buffer.from(JSON.stringify({ error })),
  };
}

function sendFailure(response: Response, status: number, error: string): void {
  for (const name of [...DEFAULT_RESPONSE_HEADERS, ...CONTROL_RESPONSE_HEADERS]) response.removeHeader(name);
  writeResponse(response, failureResponse(status, error));
}

function writeResponse(response: Response, value: PaymentReplayResponse): void {
  response.statusCode = value.status;
  for (const [name, header] of Object.entries(value.headers)) response.setHeader(name, header);
  response.end(Buffer.from(value.body));
}

function captureWriteHead(response: Response): void {
  response.writeHead = new Proxy(response.writeHead.bind(response), {
    apply(target, receiver: Response, args: unknown[]) {
      if (typeof args[0] === 'number') receiver.statusCode = args[0];
      const headers = typeof args[1] === 'string' ? args[2] : args[1];
      if (Array.isArray(headers)) {
        const seen = new Set<string>();
        for (let index = 0; index < headers.length; index += 2) {
          const name: unknown = headers[index];
          const value: unknown = headers[index + 1];
          if (typeof name === 'string' && typeof value === 'string') {
            if (seen.has(name.toLowerCase())) receiver.appendHeader(name, value);
            else receiver.setHeader(name, value);
            seen.add(name.toLowerCase());
          }
        }
      }
      if (headers !== undefined && headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
        for (const [name, value] of Object.entries(headers)) {
          if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value))
            receiver.setHeader(name, value as string | number | string[]);
        }
      }
      return Reflect.apply(target, receiver, args) as Response;
    },
  });
}

function limitHandlerResponse(response: Response, state: ReplayRequest, limit: number): void {
  let bytes = 0;
  function accept(args: unknown[]): boolean {
    const value = args[0];
    const encoding = typeof args[1] === 'string' ? (args[1] as BufferEncoding) : 'utf8';
    if (typeof value === 'string') bytes += Buffer.byteLength(value, encoding);
    else if (value instanceof Uint8Array) bytes += value.byteLength;
    if (bytes <= limit) {
      if (typeof value === 'string') args[0] = Buffer.from(value, encoding);
      return true;
    }
    state.failure = { status: 503, error: 'payment_replay_response_too_large' };
    return false;
  }
  response.write = new Proxy(response.write.bind(response), {
    apply(target, receiver: Response, args: unknown[]) {
      return accept(args) ? (Reflect.apply(target, receiver, args) as boolean) : true;
    },
  });
  response.end = new Proxy(response.end.bind(response), {
    apply(target, receiver: Response, args: unknown[]) {
      return Reflect.apply(target, receiver, accept(args) ? args : []) as Response;
    },
  });
}

function responseBarrier(
  response: Response,
  names: readonly string[],
  limit: number,
): {
  result: Promise<PaymentReplayResponse>;
  emit(value: PaymentReplayResponse): void;
} {
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  const originalWriteHead = response.writeHead.bind(response);
  const originalFlush = response.flushHeaders.bind(response);
  // Authentication/security middleware runs before this helper. Its current headers are not persisted or replayed.
  const freshHeaders = Object.fromEntries(
    Object.entries(response.getHeaders()).filter(
      ([name]) => !names.includes(name) && !CONTROL_RESPONSE_HEADERS.includes(name),
    ),
  );
  const chunks: Buffer[] = [];
  let bytes = 0;
  let resolveResult: (value: PaymentReplayResponse) => void = () => {};
  let rejectResult: (error: Error) => void = () => {};
  const result = new Promise<PaymentReplayResponse>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => {});
  function buffer(args: unknown[]): void {
    const value = args[0];
    if (typeof value !== 'string' && !(value instanceof Uint8Array)) return;
    const encoding = typeof args[1] === 'string' ? (args[1] as BufferEncoding) : 'utf8';
    const chunk = typeof value === 'string' ? Buffer.from(value, encoding) : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > limit) rejectResult(new Error('Replay response exceeds byte limit'));
    else chunks.push(chunk);
  }
  response.write = new Proxy(originalWrite, {
    apply(_target, _receiver, args: unknown[]) {
      buffer(args);
      return true;
    },
  });
  response.end = new Proxy(originalEnd, {
    apply(_target, _receiver, args: unknown[]) {
      buffer(args);
      resolveResult({
        status: response.statusCode,
        headers: selectedResponseHeaders(response, names),
        body: Buffer.concat(chunks),
      });
      return response;
    },
  });
  response.writeHead = new Proxy(originalWriteHead, {
    apply(_target, _receiver, args: unknown[]) {
      if (typeof args[0] === 'number') response.statusCode = args[0];
      return response;
    },
  });
  response.flushHeaders = () => {
    rejectResult(new Error('Streaming replay responses are unsupported'));
  };
  return {
    result,
    emit(value) {
      response.write = originalWrite;
      response.end = originalEnd;
      response.writeHead = originalWriteHead;
      response.flushHeaders = originalFlush;
      for (const name of response.getHeaderNames()) response.removeHeader(name);
      response.statusCode = value.status;
      for (const [name, header] of Object.entries(value.headers)) response.setHeader(name, header);
      for (const [name, header] of Object.entries(freshHeaders)) {
        if (header !== undefined) response.setHeader(name, header);
      }
      response.end(Buffer.from(value.body));
    },
  };
}
