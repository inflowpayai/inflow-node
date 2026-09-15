import { CONTRACTS, InflowHttpClient, type InflowAnonymousClientOptions } from '@inflowpayai/x402';
import { INFLOW_EIP7702_GAS_SPONSORING, type InflowEip7702GasSponsoringInfo } from '@inflowpayai/x402/extensions';
import type { ClientExtension } from '@x402/core/client';
import type { PaymentPayload } from '@x402/core/types';
import { getPermit2AllowanceReadParams, x402ExactPermit2ProxyABI, type ClientEvmSigner } from '@x402/evm';
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  recoverMessageAddress,
  serializeSignature,
  zeroAddress,
  type Address,
  type Authorization,
  type AuthorizationRequest,
  type Hex,
  type SignedAuthorization,
} from 'viem';
import { entryPoint07Address, getUserOperationHash } from 'viem/account-abstraction';
import { recoverAuthorizationAddress } from 'viem/utils';

const PREPARE_PATH = '/v1/x402/eip7702/prepare';
const DELEGATION = '0x77021100bD87b7008E5E1989d0eB38555d0d0000';
const BATCH_ABI = parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);

export interface InflowEip7702Signer {
  readonly address: Address;
  readContract: NonNullable<ClientEvmSigner['readContract']>;
  signMessage(args: { message: { raw: Hex } }): Promise<Hex>;
  signAuthorization(authorization: AuthorizationRequest): Promise<SignedAuthorization>;
}

export interface InflowEip7702GasSponsoringOptions extends Omit<InflowAnonymousClientOptions, 'apiKey'> {
  signer: InflowEip7702Signer;
  /** Delegation persists after failed payment execution. Return true only after the owner consents. */
  consentToDelegation: (authorization: AuthorizationRequest) => Promise<boolean>;
}

export interface InflowEip7702UserOperation {
  /** External owner's account address. */
  sender: Address;
  /** EntryPoint nonce, including the default-owner validation key. */
  nonce: Hex;
  /** Canonical atomic approval and Permit2 settlement batch. */
  callData: Hex;
  /** Execution gas limit. */
  callGasLimit: Hex;
  /** Account validation gas limit. */
  verificationGasLimit: Hex;
  /** Bundler overhead gas. */
  preVerificationGas: Hex;
  /** Maximum total gas price. */
  maxFeePerGas: Hex;
  /** Maximum priority gas price. */
  maxPriorityFeePerGas: Hex;
  /** Zero address for hosted bundler sponsorship. */
  paymaster: Address;
  /** Paymaster authorization data. */
  paymasterData: Hex;
  /** Paymaster validation gas limit. */
  paymasterVerificationGasLimit: Hex;
  /** Paymaster post-operation gas limit. */
  paymasterPostOpGasLimit: Hex;
}

export interface InflowEip7702PreparedPayment {
  /** Immutable hosted preparation identifier. */
  sponsorshipId: string;
  /** Chain on which the payment executes. */
  chainId: number;
  /** Pinned EntryPoint contract. */
  entryPoint: Address;
  /** Empty-initCode EntryPoint hashing profile. */
  entryPointVersion: '0.7';
  /** Pinned SemiModularAccount7702 implementation. */
  delegation: Address;
  /** Chain-specific delegation tuple, absent when already delegated. */
  authorization?: Authorization;
  /** Complete unsigned operation; factory and initialization data are forbidden. */
  userOperation: InflowEip7702UserOperation;
  /** Unprefixed EntryPoint operation hash. */
  userOperationHash: Hex;
  /** Hosted preparation expiry, in Unix seconds. */
  expiresAt: number;
}

export class X402Eip7702SponsoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402Eip7702SponsoringError';
  }
}

/**
 * Opt-in external-wallet extension. Prepares and signs, but never broadcasts. Uses only the caller-configured InFlow
 * endpoint; merchant declarations cannot select a preparation service. Importing the main buyer package does not load
 * it.
 */
export function createInflowEip7702GasSponsoringExtension(options: InflowEip7702GasSponsoringOptions): ClientExtension {
  const { signer, consentToDelegation, ...httpOptions } = options;
  const http = new InflowHttpClient(httpOptions);
  return {
    key: INFLOW_EIP7702_GAS_SPONSORING,
    async enrichPaymentPayload(payload, required) {
      const declaration = required.extensions?.[INFLOW_EIP7702_GAS_SPONSORING];
      if (
        declaration === undefined ||
        payload.accepted.scheme !== 'exact' ||
        payload.accepted.extra['assetTransferMethod'] !== 'permit2'
      )
        return payload;
      const info = record(record(declaration, ['info'])['info'], ['version']);
      assert(info['version'] === '1', 'Unsupported EIP-7702 sponsorship version');
      const payment = structuredClone(payload);
      const expected = paymentBatch(payment, signer.address);
      const allowance = await signer.readContract(
        getPermit2AllowanceReadParams({
          tokenAddress: expected.asset,
          ownerAddress: signer.address,
        }),
      );
      assert(typeof allowance === 'bigint' && allowance >= 0n, 'Invalid Permit2 allowance');
      if (allowance >= expected.amount) return payload;
      const prepared = parsePrepared(
        await http.post<unknown>(
          PREPARE_PATH,
          {
            paymentPayload: payment,
            paymentRequirements: payment.accepted,
          },
          { retries: 0 },
        ),
      );
      assert(
        prepared.chainId === expected.chainId &&
          isAddressEqual(prepared.entryPoint, entryPoint07Address) &&
          isAddressEqual(prepared.delegation, DELEGATION),
        'Unexpected chain, EntryPoint, or delegation',
      );
      const operation = prepared.userOperation;
      assert(
        isAddressEqual(operation.sender, signer.address) &&
          operation.callData.toLowerCase() === expected.callData.toLowerCase(),
        'Prepared operation does not match the payment',
      );
      assert(BigInt(operation.nonce) >> 64n === 1n, 'Unsupported account nonce key');
      assert(
        isAddressEqual(operation.paymaster, zeroAddress) &&
          operation.paymasterData === '0x' &&
          operation.paymasterVerificationGasLimit === '0x0' &&
          operation.paymasterPostOpGasLimit === '0x0' &&
          operation.maxFeePerGas === '0x0' &&
          operation.maxPriorityFeePerGas === '0x0' &&
          operation.preVerificationGas === '0x0' &&
          BigInt(operation.callGasLimit) > 0n &&
          BigInt(operation.verificationGasLimit) > 0n,
        'Unexpected bundler sponsorship profile',
      );
      const hash = getUserOperationHash({
        chainId: prepared.chainId,
        entryPointAddress: entryPoint07Address,
        entryPointVersion: '0.7',
        userOperation: {
          sender: operation.sender,
          callData: operation.callData,
          nonce: BigInt(operation.nonce),
          callGasLimit: BigInt(operation.callGasLimit),
          verificationGasLimit: BigInt(operation.verificationGasLimit),
          preVerificationGas: BigInt(operation.preVerificationGas),
          maxFeePerGas: BigInt(operation.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(operation.maxPriorityFeePerGas),
          signature: '0x',
        },
      });
      assert(hash.toLowerCase() === prepared.userOperationHash.toLowerCase(), 'Prepared operation hash mismatch');
      const checkExpiry = () =>
        assert(
          prepared.expiresAt > Math.floor(Date.now() / 1000) && BigInt(prepared.expiresAt) <= expected.deadline,
          'Prepared sponsorship expired or exceeds the payment deadline',
        );
      checkExpiry();
      let authorizationSignature: Hex | undefined;
      if (prepared.authorization !== undefined) {
        const authorization = prepared.authorization;
        assert(
          authorization.chainId === expected.chainId && isAddressEqual(authorization.address, DELEGATION),
          'Unexpected delegation authorization',
        );
        assert(await consentToDelegation({ ...authorization }), 'Delegation consent declined');
        checkExpiry();
        const signed = await signer.signAuthorization({ ...authorization });
        assert(
          signed.chainId === authorization.chainId &&
            signed.nonce === authorization.nonce &&
            isAddressEqual(signed.address, DELEGATION),
          'Signer changed the delegation authorization',
        );
        authorizationSignature = serializeSignature(signed);
        assert(
          isAddressEqual(
            await recoverAuthorizationAddress({ authorization, signature: authorizationSignature }),
            signer.address,
          ),
          'Delegation authorization has the wrong signer',
        );
      }
      checkExpiry();
      const signature = bytes(await signer.signMessage({ message: { raw: hash } }), 65);
      assert(
        isAddressEqual(await recoverMessageAddress({ message: { raw: hash }, signature }), signer.address),
        'Prepared operation has the wrong signer',
      );
      checkExpiry();
      const signedInfo: InflowEip7702GasSponsoringInfo = {
        version: '1',
        sponsorshipId: prepared.sponsorshipId,
        signature,
        ...(authorizationSignature === undefined ? {} : { authorizationSignature }),
      };
      return {
        ...payment,
        extensions: { ...payment.extensions, [INFLOW_EIP7702_GAS_SPONSORING]: { info: signedInfo } },
      };
    },
  };
}

function paymentBatch(payment: PaymentPayload, owner: Address) {
  const requirement = payment.accepted;
  assert(payment.x402Version === 2 && /^eip155:[1-9][0-9]*$/u.test(requirement.network), 'Expected an EVM V2 payment');
  const chainId = integer(Number(requirement.network.slice(7)));
  const authorization = record(payment.payload['permit2Authorization']);
  const permitted = record(authorization['permitted']);
  const witness = record(authorization['witness']);
  const asset = address(permitted['token']);
  const amount = decimal(permitted['amount']);
  const deadline = decimal(authorization['deadline']);
  assert(
    amount > 0n &&
      amount === decimal(requirement.amount) &&
      isAddressEqual(asset, address(requirement.asset)) &&
      isAddressEqual(address(authorization['from']), owner) &&
      isAddressEqual(address(authorization['spender']), CONTRACTS.PERMIT2_PROXY) &&
      isAddressEqual(address(requirement.extra['permit2Proxy']), CONTRACTS.PERMIT2_PROXY) &&
      isAddressEqual(address(witness['to']), address(requirement.payTo)),
    'Permit2 authorization does not match the payment',
  );
  assert(deadline > BigInt(Math.floor(Date.now() / 1000)), 'Permit2 payment expired');
  const settle = encodeFunctionData({
    abi: x402ExactPermit2ProxyABI,
    functionName: 'settle',
    args: [
      { permitted: { token: asset, amount }, nonce: decimal(authorization['nonce']), deadline },
      owner,
      { to: address(witness['to']), validAfter: decimal(witness['validAfter']) },
      bytes(payment.payload['signature'], 65),
    ],
  });
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CONTRACTS.PERMIT2, amount] });
  const callData = encodeFunctionData({
    abi: BATCH_ABI,
    functionName: 'executeBatch',
    args: [
      [
        { target: asset, value: 0n, data: approve },
        { target: CONTRACTS.PERMIT2_PROXY, value: 0n, data: settle },
      ],
    ],
  });
  return { asset, amount, deadline, chainId, callData };
}

function parsePrepared(value: unknown): InflowEip7702PreparedPayment {
  const input = record(value);
  const sponsorshipId = input['sponsorshipId'];
  assert(
    typeof sponsorshipId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sponsorshipId),
    'Invalid sponsorship identifier',
  );
  assert(input['entryPointVersion'] === '0.7', 'Unsupported EntryPoint version');
  const operation = record(input['userOperation'], [
    'sender',
    'nonce',
    'callData',
    'callGasLimit',
    'verificationGasLimit',
    'preVerificationGas',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
    'paymaster',
    'paymasterData',
    'paymasterVerificationGasLimit',
    'paymasterPostOpGasLimit',
  ]);
  const authorization =
    input['authorization'] === undefined ? undefined : record(input['authorization'], ['address', 'chainId', 'nonce']);
  return {
    sponsorshipId,
    chainId: integer(input['chainId']),
    entryPoint: address(input['entryPoint']),
    entryPointVersion: '0.7',
    delegation: address(input['delegation']),
    userOperationHash: bytes(input['userOperationHash'], 32),
    expiresAt: integer(input['expiresAt']),
    ...(authorization === undefined
      ? {}
      : {
          authorization: {
            address: address(authorization['address']),
            chainId: integer(authorization['chainId']),
            nonce: integer(authorization['nonce']),
          },
        }),
    userOperation: {
      sender: address(operation['sender']),
      nonce: quantity(operation['nonce']),
      callData: bytes(operation['callData']),
      callGasLimit: quantity(operation['callGasLimit'], 128),
      verificationGasLimit: quantity(operation['verificationGasLimit'], 128),
      preVerificationGas: quantity(operation['preVerificationGas']),
      maxFeePerGas: quantity(operation['maxFeePerGas'], 128),
      maxPriorityFeePerGas: quantity(operation['maxPriorityFeePerGas'], 128),
      paymaster: address(operation['paymaster']),
      paymasterData: bytes(operation['paymasterData']),
      paymasterVerificationGasLimit: quantity(operation['paymasterVerificationGasLimit'], 128),
      paymasterPostOpGasLimit: quantity(operation['paymasterPostOpGasLimit'], 128),
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new X402Eip7702SponsoringError(message);
}

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a sponsorship object');
  assert(keys === undefined || Object.keys(value).every((key) => keys.includes(key)), 'Unsupported sponsorship fields');
  return value as Record<string, unknown>;
}

function address(value: unknown): Address {
  assert(typeof value === 'string' && isAddress(value, { strict: false }), 'Invalid sponsorship address');
  return getAddress(value);
}

function bytes(value: unknown, length?: number): Hex {
  assert(
    typeof value === 'string' &&
      /^0x(?:[0-9a-f]{2})*$/iu.test(value) &&
      (length === undefined || value.length === 2 + length * 2),
    'Invalid sponsorship bytes',
  );
  return value as Hex;
}

function quantity(value: unknown, bits = 256): Hex {
  assert(
    typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value) && BigInt(value) < 1n << BigInt(bits),
    'Invalid sponsorship quantity',
  );
  return value as Hex;
}

function decimal(value: unknown): bigint {
  assert(
    typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) < 1n << 256n,
    'Invalid payment amount or nonce',
  );
  return BigInt(value);
}

function integer(value: unknown): number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'Invalid sponsorship integer');
  return value;
}
