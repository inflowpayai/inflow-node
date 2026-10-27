import { once } from 'node:events';

import { CONTRACTS, type X402ConfigResponse } from '@inflowpayai/x402';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { isEIP3009Payload, type ExactEvmPayloadV2 } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { paymentMiddlewareFromConfig } from '@x402/express';
import express from 'express';
import { verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowRoute,
  inflowSchemeRegistrations,
} from '../../src/index.js';

const buyer = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000001');
const payTo = '0x2222222222222222222222222222222222222222';
const networks = [
  { blockchain: 'ARC', chainId: 5042, asset: '0x3600000000000000000000000000000000000000' },
  { blockchain: 'ARC', chainId: 5042002, asset: '0x3600000000000000000000000000000000000000' },
  { blockchain: 'MONAD', chainId: 143, asset: '0x754704bc059f8c67012fed69bc8a327a5aafb603' },
  { blockchain: 'MONAD', chainId: 10143, asset: '0x534b2f3a21130d7a60830c2df862319e593943a3' },
] as const;

interface FacilitatorRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

describe('Arc and Monad exact payments through foundation Express', () => {
  it.each(networks)('preserves $blockchain chain $chainId USDC offers and signatures', async (chain) => {
    const network = `eip155:${chain.chainId}` as const;
    const kind = { scheme: 'exact', network, x402Version: 2 };
    const config: X402ConfigResponse = {
      assets: [
        {
          assetId: chain.asset,
          assetName: 'USDC',
          assetTransferMethod: 'eip3009',
          blockchain: chain.blockchain,
          currency: 'USDC',
          decimals: 6,
          network,
          ...(chain.blockchain === 'MONAD' ? { permit2Proxy: CONTRACTS.PERMIT2_PROXY } : {}),
          tokenName: 'USDC',
          tokenVersion: '2',
        },
      ],
      paymentMethods: [],
      sellerId: '00000000-0000-0000-0000-000000000001',
      supported: [kind],
      wallets: [
        { address: '0x3333333333333333333333333333333333333333', blockchain: 'BASE', network: 'eip155:8453' },
        { address: payTo, blockchain: chain.blockchain, network },
      ],
    };
    const original = structuredClone(config);
    const calls: FacilitatorRequest[] = [];
    const app = express();
    app.use(express.json());
    app.get('/v1/x402/config', (_request, response) => response.json(config));
    app.get('/v1/x402/supported', (_request, response) =>
      response.json({ kinds: [kind], extensions: [], signers: {} }),
    );
    app.post<Record<string, never>, unknown, FacilitatorRequest>('/v1/x402/verify', (request, response) => {
      calls.push(request.body);
      response.json({ isValid: true, payer: buyer.address });
    });
    app.post<Record<string, never>, unknown, FacilitatorRequest>('/v1/x402/settle', (request, response) => {
      calls.push(request.body);
      response.json({ success: true, network, transaction: '0xsettled', payer: buyer.address });
    });
    const listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    try {
      const address = listener.address();
      if (address === null || typeof address === 'string') throw new Error('Expected a local listener');
      const baseUrl = `http://127.0.0.1:${address.port.toString()}`;
      const options = { environment: 'sandbox' as const, apiKey: 'local-test-key', baseUrl };
      const seller = await createInflowSellerClient(options);
      const route = await inflowRoute(seller, { price: '$0.01', schemes: ['exact'], networks: [network] });
      expect(route.extensions).toBeUndefined();
      expect(await inflowAccepts(seller, { price: '$0.01', networks: ['eip155:8453'] })).toEqual([]);
      const permit2 = await inflowRoute(seller, { price: '$0.01', schemes: ['exact'], assetTransferMethod: 'permit2' });
      const permit2Offers = Array.isArray(permit2.accepts) ? permit2.accepts : [permit2.accepts];
      expect(permit2Offers).toHaveLength(chain.blockchain === 'ARC' ? 0 : 1);
      const registrations = await inflowSchemeRegistrations(seller);
      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.server.paymentFlows).toEqual({
        eip3009: { supported: ['authorization', 'upfront'], default: 'authorization' },
        ...(chain.blockchain === 'MONAD'
          ? { permit2: { supported: ['authorization', 'upfront'], default: 'authorization' } }
          : {}),
      });
      app.use(paymentMiddlewareFromConfig({ 'GET /report': route }, [createInflowFacilitator(options)], registrations));
      app.get('/report', (_request, response) => response.json({ report: 'protected result' }));

      const challenge = await fetch(`${baseUrl}/report`);
      expect(challenge.status).toBe(402);
      const header = challenge.headers.get('payment-required');
      if (header === null) throw new Error('Missing payment challenge');
      const required = decodePaymentRequiredHeader(header);
      expect(required.accepts).toHaveLength(1);
      expect(required.accepts[0]).toEqual({
        scheme: 'exact',
        network,
        asset: chain.asset,
        amount: '10000',
        payTo,
        maxTimeoutSeconds: 300,
        extra: { assetName: 'USDC', name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
      });
      const client = new x402Client();
      client.setSpendControls({ allowedAssets: [{ network, asset: chain.asset, maxAmountPerPayment: '10000' }] });
      registerExactEvmScheme(client, { signer: buyer, networks: [network] });
      const payment = await client.createPaymentPayload(required);
      // The foundation's generic payload record comes from the registered ExactEvmScheme.
      const payload = payment.payload as ExactEvmPayloadV2;
      if (!isEIP3009Payload(payload) || payload.signature === undefined)
        throw new Error('Expected a signed EIP-3009 payment');
      const { authorization, signature } = payload;
      expect(authorization).toMatchObject({ from: buyer.address, to: payTo, value: '10000' });
      const typedData = {
        address: buyer.address,
        domain: { name: 'USDC', version: '2', chainId: chain.chainId, verifyingContract: chain.asset },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          ...authorization,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
        },
        signature,
      } as const;
      expect(await verifyTypedData(typedData)).toBe(true);
      expect(await verifyTypedData({ ...typedData, domain: { ...typedData.domain, chainId: 8453 } })).toBe(false);
      const paid = await fetch(`${baseUrl}/report`, {
        headers: { 'payment-signature': encodePaymentSignatureHeader(payment) },
      });
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ report: 'protected result' });
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.paymentRequirements).toEqual(payment.accepted);
        expect(call.paymentPayload.accepted).toEqual(payment.accepted);
        expect(call.paymentPayload.payload).toEqual(payment.payload);
        expect(call.paymentPayload.extensions).toEqual(calls[0]?.paymentPayload.extensions);
      }
      expect(config).toEqual(original);
    } finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
