# Protocol mapping

How the InFlow MPP wire format maps to the SDK types and the MPP/IETF spec. The SDK produces and parses byte-identical
shapes; the source of truth is the MPP wire format and the spec at [mpp.dev](https://mpp.dev/protocol/challenges).

## Wire models ↔ SDK types

| MPP spec / IETF                            | SDK type (`@inflowpayai/mpp`)                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `WWW-Authenticate: Payment` challenge      | `MppChallenge`                                                                                               |
| `Authorization: Payment <credential>`      | `MppCredential`                                                                                              |
| `Payment-Receipt`                          | `MppReceipt`                                                                                                 |
| RFC 9457 problem detail                    | `MppProblemDetail`                                                                                           |
| method-specific challenge `request` object | `InflowChallengeRequest` / `inflowChargeRequestSchema`; `TempoChallengeRequest` / `tempoChargeRequestSchema` |

Enum-valued fields are carried as their lowercase wire labels: `method` → `"inflow"` or `"tempo"`, `intent` →
`"charge"`, and `rail` → `"balance"` (crypto) or `"instrument"` (fiat). The SDK types use these wire forms with an open
`(string & {})` branch so a label added later does not break the type.

## Canonical encoding (the byte-parity contract)

`request`, `opaque`, `credential`, and `receipt` are carried as **base64url-without-padding over RFC 8785 JCS JSON**.
The SDK's `canonicalize` implements JCS exactly, dropping `null`/`undefined` properties before serialising:

- object keys sorted by UTF-16 code unit;
- object properties whose value is `null`/`undefined` dropped before sorting;
- JSON numbers formatted by the ECMAScript `Number::toString`, which is exactly what RFC 8785 specifies (so `String(n)`
  is canonical, including `-0` → `0` and `1e+21`);
- strings escape `"`, `\`, and the C0 control set (`\b \f \n \r \t`, else `\u00xx` lowercase); all other code points,
  including non-ASCII, are emitted verbatim as UTF-8.

Getting this wrong yields a challenge or credential that fails to validate, so the codec is implemented exactly and
tested against byte vectors rather than delegated to a generic JSON serialiser. Amounts are **decimal strings**
end-to-end (e.g. `'10'`, `'1.5'`), normalised without trailing zeros; the SDK never routes an amount through `Number()`,
which would lose precision.

## `WWW-Authenticate: Payment` grammar

`renderChallengeHeader` / `parseChallengeHeader` implement the `Payment` challenge grammar:

- field order on render: `id, realm, method, intent, request, expires?, description?, digest?, opaque?`;
- the `Payment` scheme prefix is matched case-insensitively on parse (RFC 7235);
- `description` is the only RFC 7235 quoted-string-escaped field (`\` and `"` escaped; raw control chars rejected);
- `parseChallengeHeaders` handles multiple challenges (a repeated-header array, or one combined value).

## The `inflow` request object

The challenge `request` object carries the charge essentials at the top level — `amount` (decimal string), `currency`,
and `recipient` — and nests the settlement selectors under a `methodDetails` sub-object: `rail` (`balance` |
`instrument`) and, for an instrument-rail charge, the optional `instrumentId`. This follows the MPP convention of
nesting method-specific selectors under `methodDetails`. `inflowChargeRequestSchema` mirrors that shape, and the nested
`methodDetails` JCS-encodes deterministically (sorted keys) so byte parity holds. The seller derives `rail` from the
charge currency via the `currencyRails` capability advertised in `GET /v1/mpp/config`; the buyer does not choose it.

## The `tempo` request object

The Tempo challenge `request` object carries `amount` as a base-unit integer string, `currency` as a TIP-20 token
address, and `recipient` as a Tempo address. `methodDetails` carries the Tempo chain id, a fee-payer capability flag,
optional bytes32 primary memo, split transfers, and supported submission modes (`pull` or `push`). The current
seller/server path emits `feePayer: false` by default and preserves opt-in `feePayer: true` for sponsored settlement.
The corresponding credential payload carries `type: "transaction"` with a signed transaction, `type: "hash"` with a
submitted transaction hash, or `type: "proof"` with a zero-amount proof signature.

## `source` / payer identity

Per the MPP spec, `MppCredential.source` is the payer identity (DID / address / account id). It is set **server-side**:
the buyer calls `POST /v1/transactions/mpp`, InFlow returns an `MppCredential` that already carries `source`, and the
buyer decodes that credential and re-serialises it for the `Authorization: Payment` header — it does not synthesise
`source` itself.
