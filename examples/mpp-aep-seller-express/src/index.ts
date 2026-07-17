import 'dotenv/config';
import type { Server } from 'node:http';

import { createMppAepSellerApp } from './app.js';

const apiKey = requiredEnvironment('INFLOW_API_KEY');
const mppSecretKey = requiredEnvironment('MPP_SECRET_KEY');
const serviceDid = requiredEnvironment('SERVICE_DID');
const baseUrl = process.env['INFLOW_BASE_URL'];
const host = process.env['HOST'] ?? '127.0.0.1';
const port = parsePort(process.env['PORT'] ?? '3000');
const listenUrl = `http://${host}:${port.toString()}`;
const { app } = createMppAepSellerApp({
  apiKey,
  ...(baseUrl === undefined ? {} : { baseUrl }),
  listenUrl,
  mppSecretKey,
  serviceDid,
});
const server: Server = app.listen(port, host);

server.once('error', (error) => {
  console.error(`Unable to listen on ${listenUrl}:`, error);
  process.exitCode = 1;
});
server.once('listening', () => {
  console.log(`AEP and MPP seller listening on ${listenUrl}`);
  console.log(`  GET  ${listenUrl}/.well-known/aep`);
  console.log(`  POST ${listenUrl}/aep/enroll`);
  console.log(`  POST ${listenUrl}/aep/grant`);
  console.log(`  GET  ${listenUrl}/aep/status`);
  console.log(`  POST ${listenUrl}/aep/revoke`);
  console.log(`  GET  ${listenUrl}/openapi.json`);
  console.log(`  GET  ${listenUrl}/api/widgets`);
  console.log(`  POST ${listenUrl}/api/upload`);
  console.log(`  GET  ${listenUrl}/free`);
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new TypeError(`Invalid PORT: ${value}`);
  return port;
}
