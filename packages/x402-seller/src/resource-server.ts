import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';

import { inflowSchemeRegistrations, type InflowSchemeRegistrationsOptions } from './scheme-registrations.js';
import type { InflowSellerClient } from './seller-client.js';

type ResourceServer = {
  register(...args: Parameters<x402ResourceServer['register']>): unknown;
};

export function createInflowResourceServer<Server extends ResourceServer>(
  client: InflowSellerClient,
  facilitatorClients: FacilitatorClient | FacilitatorClient[],
  options: InflowSchemeRegistrationsOptions & {
    resourceServer: new (facilitators: FacilitatorClient | FacilitatorClient[]) => Server;
  },
): Promise<Server>;
export function createInflowResourceServer(
  client: InflowSellerClient,
  facilitatorClients: FacilitatorClient | FacilitatorClient[],
  options?: InflowSchemeRegistrationsOptions,
): Promise<x402ResourceServer>;
export async function createInflowResourceServer(
  client: InflowSellerClient,
  facilitatorClients: FacilitatorClient | FacilitatorClient[],
  options: InflowSchemeRegistrationsOptions & {
    resourceServer?: new (facilitators: FacilitatorClient | FacilitatorClient[]) => ResourceServer;
  } = {},
): Promise<ResourceServer> {
  const server = new (options.resourceServer ?? x402ResourceServer)(facilitatorClients);
  for (const registration of await inflowSchemeRegistrations(client, options)) {
    server.register(registration.network, registration.server);
  }
  return server;
}
