---
'@inflowpayai/mpp': patch
'@inflowpayai/mpp-seller': patch
---

Remove the MPP protocol/SDK version gate. The server's `GET /v1/mpp/config` response no longer carries `protocolVersion`
or `minSdkVersion`, so the SDK no longer reads or enforces them. Removed from `@inflowpayai/mpp`: the
`MPP_PROTOCOL_VERSION` and `MPP_SDK_VERSION` constants, the `MppProtocolVersionError` error class, and the
`protocolVersion`/`minSdkVersion` fields on the `MppConfigResponse` type. `@inflowpayai/mpp-seller` no longer re-exports
`MppProtocolVersionError`, and `createConfigClient` no longer version-gates on load.
