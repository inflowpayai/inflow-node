---
'@inflowpayai/x402': patch
'@inflowpayai/x402-buyer': patch
'@inflowpayai/x402-seller': patch
---

Require x402 foundation 2.27.0 for protected-route fixes and updated external-wallet spending controls. Update framework
compatibility coverage and custom-mint example configuration. Fastify remains on its published 2.26.0 adapter and does
not receive the 2.27.0 route fix.

Apply registered policies and declared extension lifecycle hooks to managed payments. Run before and after hooks for
two-phase payments while preserving their server payload, cancellation, and shared completion behavior.
