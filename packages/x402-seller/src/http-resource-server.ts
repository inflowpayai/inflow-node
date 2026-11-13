import { x402HTTPResourceServer, type x402ResourceServer } from '@x402/core/server';
import type { HTTPRequestContext, RouteConfig, RoutesConfig } from '@x402/core/http';
import { bazaarResourceServerExtension, validateBazaarRouteExtensions } from '@x402/extensions/bazaar';

export type InflowRouteResolver = (context: HTTPRequestContext) => RouteConfig | Promise<RouteConfig>;
export type InflowRoutesConfig = Record<string, RouteConfig | InflowRouteResolver>;

type HTTPServer = Pick<
  x402HTTPResourceServer,
  'initialize' | 'requiresPayment' | 'processHTTPRequest' | 'processSettlement'
> & {
  onProtectedRequest(hook: Parameters<x402HTTPResourceServer['onProtectedRequest']>[0]): unknown;
  registerPaywallProvider(provider: Parameters<x402HTTPResourceServer['registerPaywallProvider']>[0]): unknown;
};

type CoreServer = Pick<x402ResourceServer, 'hasExtension'> & {
  registerExtension(extension: Parameters<x402ResourceServer['registerExtension']>[0]): unknown;
};

export function createInflowHTTPResourceServer<Core extends CoreServer, Server extends HTTPServer>(
  server: Core,
  routes: InflowRoutesConfig,
  options: { httpServer: new (server: Core, routes: RoutesConfig) => Server },
): Server;
export function createInflowHTTPResourceServer(
  server: x402ResourceServer,
  routes: InflowRoutesConfig,
): x402HTTPResourceServer;
export function createInflowHTTPResourceServer<Core extends x402ResourceServer, Server extends HTTPServer>(
  server: Core,
  routes: InflowRoutesConfig,
  options?: { httpServer: new (server: Core, routes: RoutesConfig) => Server },
): Server | x402HTTPResourceServer {
  const create = (config: RoutesConfig) =>
    options === undefined ? new x402HTTPResourceServer(server, config) : new options.httpServer(server, config);
  const declarations: Record<string, RouteConfig> = {};
  const resolvers = new Map<RouteConfig, { pattern: string; resolve: InflowRouteResolver }>();
  for (const [pattern, route] of Object.entries(routes)) {
    const declaration = typeof route === 'function' ? { accepts: [] } : route;
    declarations[pattern] = declaration;
    if (typeof route === 'function') resolvers.set(declaration, { pattern, resolve: route });
  }
  const http = create(declarations);
  const router = create(declarations);
  const matched = new WeakMap<
    HTTPRequestContext['adapter'],
    { pattern: string; resolve: InflowRouteResolver; context: HTTPRequestContext }
  >();
  // Use upstream routing, including its precedence and encoded-path handling, without processing a payment.
  router.onProtectedRequest((context, route) => {
    const resolver = resolvers.get(route);
    if (resolver !== undefined) matched.set(context.adapter, { ...resolver, context });
    return Promise.resolve({ grantAccess: true });
  });
  const requests = new WeakMap<HTTPRequestContext['adapter'], HTTPServer>();
  const hooks: Parameters<HTTPServer['onProtectedRequest']>[0][] = [];
  let provider: Parameters<HTTPServer['registerPaywallProvider']>[0] | undefined;
  let initialization: Promise<void> | undefined;
  const initialize = http.initialize.bind(http);
  http.initialize = () => {
    initialization ??= initialize().catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  };
  const registerHook = http.onProtectedRequest.bind(http);
  const registerPaywall = http.registerPaywallProvider.bind(http);
  Object.assign(http, {
    onProtectedRequest(hook: Parameters<HTTPServer['onProtectedRequest']>[0]) {
      hooks.push(hook);
      registerHook(hook);
      return http;
    },
    registerPaywallProvider(paywall: Parameters<HTTPServer['registerPaywallProvider']>[0]) {
      provider = paywall;
      registerPaywall(paywall);
      return http;
    },
  });
  const process = http.processHTTPRequest.bind(http);
  http.processHTTPRequest = async (context, paywall) => {
    await router.processHTTPRequest(context);
    const match = matched.get(context.adapter);
    matched.delete(context.adapter);
    if (match === undefined) return process(context, paywall);
    const resolved = await match.resolve(match.context);
    const accepts = Array.isArray(resolved.accepts) ? resolved.accepts : [resolved.accepts];
    if (accepts.length === 0) throw new Error('No payment options match the requested price and filters');
    const resolvedRoutes = { [match.pattern]: resolved };
    if (resolved.extensions?.['bazaar'] !== undefined) {
      if (!server.hasExtension('bazaar')) server.registerExtension(bazaarResourceServerExtension);
      validateBazaarRouteExtensions(resolvedRoutes);
    }
    const request = create(resolvedRoutes);
    for (const hook of hooks) request.onProtectedRequest(hook);
    if (provider !== undefined) request.registerPaywallProvider(provider);
    const result = await request.processHTTPRequest(context, paywall);
    if (result.type === 'payment-verified') requests.set(context.adapter, request);
    return result;
  };
  const settle = http.processSettlement.bind(http);
  http.processSettlement = async (...args) => {
    const adapter = args[3]?.request.adapter;
    const request = adapter === undefined ? undefined : requests.get(adapter);
    if (request === undefined) return settle(...args);
    try {
      return await request.processSettlement(...args);
    } finally {
      if (adapter !== undefined) requests.delete(adapter);
    }
  };
  return http;
}
