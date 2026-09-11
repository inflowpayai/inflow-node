import { CONTRACTS } from '@inflowpayai/x402';
import {
  declareInflowEip7702GasSponsoringExtension,
  INFLOW_EIP7702_GAS_SPONSORING,
} from '@inflowpayai/x402/extensions';
import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { x402ExactPermit2ProxyABI, type ExactPermit2Payload } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { encodeFunctionData, erc20Abi, parseAbi, recoverMessageAddress, toHex, zeroAddress, type Hex } from 'viem';
import { entryPoint07Address, getUserOperationHash } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createInflowEip7702GasSponsoringExtension,
  X402Eip7702SponsoringError,
  type InflowEip7702PreparedPayment,
  type InflowEip7702Signer,
} from '../../src/eip7702/index.js';

const owner = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const asset = '0x1111111111111111111111111111111111111111';
const delegation = '0x77021100bD87b7008E5E1989d0eB38555d0d0000';
const BATCH_ABI = parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);

function required(): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://merchant.example/paid' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset,
        amount: '123',
        payTo: other.address,
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: 'permit2', permit2Proxy: CONTRACTS.PERMIT2_PROXY },
      },
    ],
    extensions: { ...declareInflowEip7702GasSponsoringExtension(), unrelated: { info: { preserved: true } } },
  };
}

function preparation(payment: PaymentPayload): InflowEip7702PreparedPayment {
  const { permit2Authorization: authorization, signature } = payment.payload as ExactPermit2Payload;
  const settle = encodeFunctionData({
    abi: x402ExactPermit2ProxyABI,
    functionName: 'settle',
    args: [
      {
        permitted: { token: asset, amount: 123n },
        nonce: BigInt(authorization.nonce),
        deadline: BigInt(authorization.deadline),
      },
      owner.address,
      { to: other.address, validAfter: BigInt(authorization.witness.validAfter) },
      signature,
    ],
  });
  const callData = encodeFunctionData({
    abi: BATCH_ABI,
    functionName: 'executeBatch',
    args: [
      [
        {
          target: asset,
          value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CONTRACTS.PERMIT2, 123n] }),
        },
        { target: CONTRACTS.PERMIT2_PROXY, value: 0n, data: settle },
      ],
    ],
  });
  const operation = {
    sender: owner.address,
    nonce: 1n << 64n,
    callData,
    callGasLimit: 300000n,
    verificationGasLimit: 100000n,
    preVerificationGas: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    signature: '0x' as const,
  };
  return {
    sponsorshipId: '11111111-2222-4333-8444-555555555555',
    chainId: 8453,
    entryPoint: entryPoint07Address,
    entryPointVersion: '0.7',
    delegation,
    authorization: { address: delegation, chainId: 8453, nonce: 0 },
    userOperation: {
      sender: operation.sender,
      nonce: toHex(operation.nonce),
      callData,
      callGasLimit: toHex(operation.callGasLimit),
      verificationGasLimit: toHex(operation.verificationGasLimit),
      preVerificationGas: toHex(operation.preVerificationGas),
      maxFeePerGas: toHex(operation.maxFeePerGas),
      maxPriorityFeePerGas: toHex(operation.maxPriorityFeePerGas),
      paymaster: zeroAddress,
      paymasterData: '0x',
      paymasterVerificationGasLimit: '0x0',
      paymasterPostOpGasLimit: '0x0',
    },
    userOperationHash: getUserOperationHash({
      chainId: 8453,
      entryPointAddress: entryPoint07Address,
      entryPointVersion: '0.7',
      userOperation: operation,
    }),
    expiresAt: Math.floor(Date.now() / 1000) + 120,
  };
}

function fixture(
  options: {
    allowance?: unknown;
    mutate?: (prepared: InflowEip7702PreparedPayment) => void;
    signer?: Partial<InflowEip7702Signer>;
    consent?: () => Promise<boolean>;
  } = {},
) {
  const requestBodies: { paymentPayload: PaymentPayload; paymentRequirements: unknown }[] = [];
  let prepared: InflowEip7702PreparedPayment | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>((url, init) => {
    expect(url).toBe('https://sandbox.inflowpay.ai/v1/x402/eip7702/prepare');
    expect(new Headers(init?.headers).has('x-api-key')).toBe(false);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
    const body = JSON.parse(init.body) as { paymentPayload: PaymentPayload; paymentRequirements: unknown };
    requestBodies.push(body);
    prepared = preparation(body.paymentPayload);
    options.mutate?.(prepared);
    return Promise.resolve(
      new Response(JSON.stringify(prepared), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
  const signMessage = vi.fn<InflowEip7702Signer['signMessage']>(owner.signMessage);
  const signAuthorization = vi.fn<InflowEip7702Signer['signAuthorization']>(owner.signAuthorization);
  const consentToDelegation = vi.fn(options.consent ?? (() => Promise.resolve(true)));
  const readContract = vi.fn<InflowEip7702Signer['readContract']>(() => Promise.resolve(options.allowance ?? 0n));
  const extension = createInflowEip7702GasSponsoringExtension({
    environment: 'sandbox',
    fetch,
    consentToDelegation,
    signer: { address: owner.address, readContract, signMessage, signAuthorization, ...options.signer },
  });
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: owner, networks: ['eip155:8453'] });
  client.registerExtension(extension);
  return {
    client,
    fetch,
    signMessage,
    signAuthorization,
    consentToDelegation,
    readContract,
    requestBodies,
    prepared: () => prepared,
    extension,
  };
}

afterEach(() => vi.useRealTimers());

describe('EIP-7702 foundation extension with real local signatures and an HTTP preparation fixture', () => {
  it('typechecks the documented external-buyer composition', () => {
    function externalBuyer(
      signer: InflowEip7702Signer & Parameters<typeof registerExactEvmScheme>[1]['signer'],
      consentToDelegation: Parameters<typeof createInflowEip7702GasSponsoringExtension>[0]['consentToDelegation'],
    ) {
      const client = new x402Client();
      registerExactEvmScheme(client, { signer, networks: ['eip155:84532'] });
      client.registerExtension(
        createInflowEip7702GasSponsoringExtension({ environment: 'sandbox', signer, consentToDelegation }),
      );
      return client;
    }
    expect(
      externalBuyer({ ...owner, readContract: () => Promise.resolve(0n) }, () => Promise.resolve(false)),
    ).toBeInstanceOf(x402Client);
  });

  it('binds both signatures to the actual foundation payment and preserves declaration merging', async () => {
    const f = fixture();
    const payload = await f.client.createPaymentPayload(required());
    expect(f.requestBodies[0]?.paymentRequirements).toEqual(payload.accepted);
    expect(f.requestBodies[0]?.paymentPayload.payload).toEqual(payload.payload);
    expect(payload.extensions?.['unrelated']).toEqual({ info: { preserved: true } });
    const signed = payload.extensions?.[INFLOW_EIP7702_GAS_SPONSORING] as {
      info: { version: string; sponsorshipId: string; signature: Hex; authorizationSignature: Hex };
    };
    const prepared = f.prepared();
    if (!prepared?.authorization) throw new Error('Missing test preparation');
    expect(signed.info.version).toBe('1');
    expect(signed.info.sponsorshipId).toBe(prepared.sponsorshipId);
    expect(
      await recoverMessageAddress({ message: { raw: prepared.userOperationHash }, signature: signed.info.signature }),
    ).toBe(owner.address);
    expect(
      await recoverAuthorizationAddress({
        authorization: prepared.authorization,
        signature: signed.info.authorizationSignature,
      }),
    ).toBe(owner.address);
    expect(f.consentToDelegation).toHaveBeenCalledOnce();
    expect(f.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'allowance', args: [owner.address, CONTRACTS.PERMIT2] }),
    );
  });

  it('requires no delegation signature or consent for an already delegated account', async () => {
    const f = fixture({
      mutate: (p) => {
        delete p.authorization;
      },
    });
    const payload = await f.client.createPaymentPayload(required());
    expect(f.signAuthorization).not.toHaveBeenCalled();
    expect(f.consentToDelegation).not.toHaveBeenCalled();
    expect(payload.extensions?.[INFLOW_EIP7702_GAS_SPONSORING]).not.toHaveProperty('info.authorizationSignature');
  });

  it('retains only the declaration when allowance is sufficient', async () => {
    const f = fixture({ allowance: 123n });
    const payload = await f.client.createPaymentPayload(required());
    expect(payload.extensions?.[INFLOW_EIP7702_GAS_SPONSORING]).toEqual({ info: { version: '1' } });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.signAuthorization).not.toHaveBeenCalled();
    expect(f.signMessage).not.toHaveBeenCalled();
  });

  it('does nothing without a declaration or for another transfer method', async () => {
    const f = fixture();
    const challenge = required();
    delete challenge.extensions;
    const payload = await f.client.createPaymentPayload(challenge);
    const changed = { ...payload, accepted: { ...payload.accepted, extra: { assetTransferMethod: 'eip3009' } } };
    expect(await f.extension.enrichPaymentPayload?.(changed, required())).toBe(changed);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.readContract).not.toHaveBeenCalled();
  });

  it('declines delegation before asking for either signature', async () => {
    const f = fixture({ consent: () => Promise.resolve(false) });
    await expect(f.client.createPaymentPayload(required())).rejects.toThrow('consent declined');
    expect(f.signAuthorization).not.toHaveBeenCalled();
    expect(f.signMessage).not.toHaveBeenCalled();
  });

  it.each([
    [
      'chain',
      (p: InflowEip7702PreparedPayment) => {
        p.chainId = 1;
      },
    ],
    [
      'EntryPoint',
      (p: InflowEip7702PreparedPayment) => {
        p.entryPoint = other.address;
      },
    ],
    [
      'EntryPoint version',
      (p: InflowEip7702PreparedPayment) => {
        Object.assign(p, { entryPointVersion: '0.8' });
      },
    ],
    [
      'delegation',
      (p: InflowEip7702PreparedPayment) => {
        p.delegation = other.address;
      },
    ],
    [
      'sender',
      (p: InflowEip7702PreparedPayment) => {
        p.userOperation.sender = other.address;
      },
    ],
    [
      'calldata',
      (p: InflowEip7702PreparedPayment) => {
        p.userOperation.callData = '0x';
      },
    ],
    [
      'nonce key',
      (p: InflowEip7702PreparedPayment) => {
        p.userOperation.nonce = '0x0';
      },
    ],
    [
      'sequence',
      (p: InflowEip7702PreparedPayment) => {
        p.userOperation.nonce = '0x10000000000000001';
      },
    ],
    [
      'paymaster',
      (p: InflowEip7702PreparedPayment) => {
        p.userOperation.paymaster = other.address;
      },
    ],
    [
      'paymaster data',
      (p: InflowEip7702PreparedPayment) => {
        p.userOperation.paymasterData = '0xab';
      },
    ],
    [
      'gas',
      (p: InflowEip7702PreparedPayment) => {
        p.userOperation.callGasLimit = '0x1';
      },
    ],
    [
      'gas overflow',
      (p: InflowEip7702PreparedPayment) => {
        p.userOperation.callGasLimit = toHex(1n << 128n);
      },
    ],
    [
      'noncanonical quantity',
      (p: InflowEip7702PreparedPayment) => {
        p.userOperation.nonce = '0x01';
      },
    ],
    [
      'unexpected initialization',
      (p: InflowEip7702PreparedPayment) => {
        Object.assign(p.userOperation, { factory: '0x7702' });
      },
    ],
    [
      'hash',
      (p: InflowEip7702PreparedPayment) => {
        p.userOperationHash = `0x${'00'.repeat(32)}`;
      },
    ],
    [
      'expiry',
      (p: InflowEip7702PreparedPayment) => {
        p.expiresAt = 0;
      },
    ],
    [
      'excessive expiry',
      (p: InflowEip7702PreparedPayment) => {
        p.expiresAt += 1000;
      },
    ],
    [
      'identifier',
      (p: InflowEip7702PreparedPayment) => {
        p.sponsorshipId = 'not-a-uuid';
      },
    ],
    [
      'unsafe nonce',
      (p: InflowEip7702PreparedPayment) => {
        Object.assign(p.authorization ?? {}, { nonce: Number.MAX_SAFE_INTEGER + 1 });
      },
    ],
    [
      'authorization chain',
      (p: InflowEip7702PreparedPayment) => {
        Object.assign(p.authorization ?? {}, { chainId: 0 });
      },
    ],
    [
      'authorization delegate',
      (p: InflowEip7702PreparedPayment) => {
        Object.assign(p.authorization ?? {}, { address: other.address });
      },
    ],
  ])('rejects mutated %s before signing', async (_, mutate) => {
    const f = fixture({ mutate });
    await expect(f.client.createPaymentPayload(required())).rejects.toBeInstanceOf(X402Eip7702SponsoringError);
    expect(f.signAuthorization).not.toHaveBeenCalled();
    expect(f.signMessage).not.toHaveBeenCalled();
  });

  it.each([
    'paymasterVerificationGasLimit',
    'paymasterPostOpGasLimit',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
    'preVerificationGas',
  ] as const)('rejects a nonzero %s in the hosted bundler profile', async (field) => {
    const f = fixture({
      mutate: (p) => {
        p.userOperation[field] = '0x1';
      },
    });
    await expect(f.client.createPaymentPayload(required())).rejects.toThrow('bundler sponsorship profile');
    expect(f.signMessage).not.toHaveBeenCalled();
  });

  it.each(['callGasLimit', 'verificationGasLimit'] as const)('rejects a zero %s', async (field) => {
    const f = fixture({
      mutate: (p) => {
        p.userOperation[field] = '0x0';
      },
    });
    await expect(f.client.createPaymentPayload(required())).rejects.toThrow('bundler sponsorship profile');
    expect(f.signMessage).not.toHaveBeenCalled();
  });

  it('rejects an authorization signed by another owner', async () => {
    const f = fixture({ signer: { signAuthorization: other.signAuthorization } });
    await expect(f.client.createPaymentPayload(required())).rejects.toThrow('wrong signer');
    expect(f.signMessage).not.toHaveBeenCalled();
  });

  it('rejects signer changes to the authorization tuple', async () => {
    const f = fixture({ signer: { signAuthorization: (a) => owner.signAuthorization({ ...a, nonce: a.nonce + 1 }) } });
    await expect(f.client.createPaymentPayload(required())).rejects.toThrow('changed the delegation');
    expect(f.signMessage).not.toHaveBeenCalled();
  });

  it('rejects text-signing the hash instead of raw-byte signing', async () => {
    const f = fixture({ signer: { signMessage: ({ message }) => owner.signMessage({ message: message.raw }) } });
    await expect(f.client.createPaymentPayload(required())).rejects.toThrow('wrong signer');
  });

  it('rejects a preparation that expires while consent is pending', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture({
      consent: () => {
        vi.setSystemTime(Date.now() + 121000);
        return Promise.resolve(true);
      },
    });
    await expect(f.client.createPaymentPayload(required())).rejects.toThrow('expired');
    expect(f.signAuthorization).not.toHaveBeenCalled();
  });

  it('rejects malformed allowance instead of proceeding with sponsorship', async () => {
    const f = fixture({ allowance: '0' });
    await expect(f.client.createPaymentPayload(required())).rejects.toThrow('Invalid Permit2 allowance');
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
