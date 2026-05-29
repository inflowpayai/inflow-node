# Protocol mapping

How `@inflowpayai/x402-*` types map to the x402 V2 wire format, plus the rules the SDK applies to network identifiers
and decimals.

## Wire-shape types

Every type the SDK reads or writes is defined in `@inflowpayai/x402` and is wire-shape-compatible with
`@x402/core@^2.12.0`'s V2 types. Wire types come from `@x402/core/types`; foundation route configuration and
`PaymentOption[]` (returned by `inflowAccepts`) come from `@x402/core/http`. The following table maps the names the SDK
exposes to the corresponding upstream V2 names.

| SDK type               | V2 wire counterpart                      | Notes                                                                                                                                              |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PaymentRequirements`  | `@x402/core/types` `PaymentRequirements` | Network field widened — see below.                                                                                                                 |
| `PaymentRequired`      | `PaymentRequired`                        | `accepts: PaymentRequirements[]`.                                                                                                                  |
| `InflowPaymentPayload` | `PaymentPayload`                         | The SDK refines `payload` into a discriminated union (`BalancePayloadData` / `ExactPayloadData` / `Permit2PayloadData` / `InstrumentPayloadData`). |
| `VerifyResponse`       | `VerifyResponse`                         | Re-exported verbatim.                                                                                                                              |
| `SettleResponse`       | `SettleResponse`                         | Network field widened. `transaction` and `payer` are optional (absent on failures); `extensions` exposed for ext data.                             |
| `ResourceInfo`         | `ResourceInfo`                           | Re-exported verbatim.                                                                                                                              |
| `X402SupportedKind`    | `SupportedKind`                          | Network widened; otherwise identical.                                                                                                              |

## Network identifier rules

V2 spec mandates CAIP-2. EVM uses `eip155:<chainId>` (e.g. `eip155:8453`); Solana uses the spec-strict
`solana:<first-32-base58-chars-of-genesis-hash>` (e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` for mainnet,
`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` for devnet — the foundation's `@x402/svm` rejects the shorthand
`solana:mainnet`/`solana:devnet` at `normalizeNetwork`). InFlow **extends** this with the literal `'inflow:1'` for
balance and (reserved) instrument schemes. As a result:

- The SDK's `network: string` field accepts either form.
- `@x402/core`'s `Network` template literal type (`` `${string}:${string}` ``) is strict about which
  `<family>:<reference>` values it recognises and does **not** include `'inflow:1'`. The SDK re-defines
  `PaymentRequirements`, `PaymentRequired`, `InflowPaymentPayload`, `SettleResponse`, and `X402SupportedKind` locally
  with widened `network: string` to accommodate it.
- `'inflow:1'` is the only `inflow:`-family value the SDK emits or accepts; everything else is standard CAIP-2.
- On the seller side, `InflowSellerClient.getSignerAddresses(network)` does exact-match first; if no exact entry exists
  it falls back to a `<family>:*` wildcard key (e.g. `eip155:*`, `inflow:*`).

## Scheme constants

```ts
SCHEMES = {
  EXACT: 'exact',
  BALANCE: 'balance',
  INSTRUMENT: 'instrument',
};
```

- `'exact'` is used for every on-chain transfer. The `extra` map carries `assetTransferMethod` (`'eip3009'` or
  `'permit2'` for EVM, chain-specific for non-EVM), `name` and `version` (EIP-712 domain), and `permit2Proxy` when
  applicable.
- `'balance'` is used for InFlow-internal ledger transfers. `network` is always `'inflow:1'`; `payTo` is the seller's
  UUID; `asset` is empty.
- `'instrument'` is reserved. `inflowAccepts` passes every scheme the server publishes through unchanged, so an
  `'instrument'` entry will flow into `PaymentOption[]` if the server ever advertises one; settlement support is not yet
  enabled end-to-end.

## Decimals

The atomic-unit `amount` carried in each `PaymentOption.price.amount` (after `inflowAccepts`) is computed from the
seller's `PriceSpec` using the **decimals from the source the entry came from**:

- For `exact` entries: `X402AssetInfo.decimals` (per `(blockchain, currency)` — e.g. `6` for USDC on Base).
- For `balance` entries: `PaymentMethodInfo.decimals` (currently `18` for InFlow balance accounting).
- The SDK never hard-codes a decimal scale.

`inflowAccepts` does this math entirely as strings to avoid `Number` / `BigInt` precision loss. Up to 8 decimal places
of input precision are accepted; precision the target asset can't represent throws `X402PriceParseError` rather than
silently truncating.

## Price formats

`PriceSpec.amount` accepts three string forms:

| Form                                 | Example                                  | Resolved currency                    |
| ------------------------------------ | ---------------------------------------- | ------------------------------------ |
| `$<integer>(.<decimals>)?`           | `'$0.01'`, `'$10.00000001'`              | `'USD'`                              |
| `<integer>(.<decimals>)? <CURRENCY>` | `'0.01 USDC'`, `'1 USDT'`, `'0.5 PYUSD'` | from the suffix                      |
| `<integer>(.<decimals>)?` (bare)     | `'0.01'`                                 | from `PriceSpec.currency` (required) |

When `PriceSpec.currency` is set alongside an amount that also embeds a currency, **`currency` wins** on conflict.

`'USD'` is a wildcard that matches any stablecoin the seller has configured (USDC, USDT, PYUSD, …). Concrete currency
codes only match the exact asset.

## Headers

V2 spec header names, used verbatim on the write path; read-side lookups are case-insensitive:

| Constant                    | Value               | Direction                     |
| --------------------------- | ------------------- | ----------------------------- |
| `HEADERS.PAYMENT_REQUIRED`  | `PAYMENT-REQUIRED`  | server → buyer (402 response) |
| `HEADERS.PAYMENT_SIGNATURE` | `PAYMENT-SIGNATURE` | buyer → server (paid retry)   |
| `HEADERS.PAYMENT_RESPONSE`  | `PAYMENT-RESPONSE`  | server → buyer (after settle) |

The SDK does **not** read or emit the V1 `X-PAYMENT` / `X-PAYMENT-RESPONSE` forms; it's V2-only and rejects responses
with any other `x402Version` via `X402VersionMismatchError`.

## `extra` map keys

```ts
EXTRA_KEYS = {
  NAME: 'name',
  VERSION: 'version',
  ASSET_TRANSFER_METHOD: 'assetTransferMethod',
  PERMIT2_PROXY: 'permit2Proxy',
  FEE_PAYER: 'feePayer',
};
```

`PaymentRequirements.extra` and `PaymentMethodInfo.extra` are intentionally open-ended on the wire. The SDK ships typed
accessors at `@inflowpayai/x402/extras` for reading and writing keys safely under `noUncheckedIndexedAccess`:

```ts
import { getExtra, setExtra } from '@inflowpayai/x402/extras';
import { EXTRA_KEYS } from '@inflowpayai/x402';

const method = getExtra<string>(req.extra, EXTRA_KEYS.ASSET_TRANSFER_METHOD);
const updated = setExtra(req.extra, EXTRA_KEYS.FEE_PAYER, '0xfee');
```

## `payload` discriminator

`InflowPaymentPayload.payload` is a discriminated union by `accepted.scheme`:

| Scheme         | Payload shape                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `'balance'`    | `BalancePayloadData` — `{ transactionId }`.                                                                               |
| `'exact'`      | `ExactPayloadData` — `{ authorization: { from, to, value, validAfter, validBefore, nonce }, signature }` (EIP-3009 form). |
| `'exact'`      | `Permit2PayloadData` — Permit2 form of the `exact` scheme; discriminate with `isPermit2Payload`.                          |
| `'instrument'` | `InstrumentPayloadData` — `{ transactionId, signature, instrumentId?, instrumentType? }`. Reserved.                       |

Narrowing helpers `isBalancePayload`, `isExactPayload`, `isPermit2Payload`, `isInstrumentPayload` discriminate without
bangs. Use `isExactPayload` + `isPermit2Payload` together to split the two `'exact'` variants.

## See also

- [architecture.md](./architecture.md) for the seller/buyer composition story.
- [extensions.md](./extensions.md) for `PaymentRequired.extensions` and `PaymentPayload.extensions`.
