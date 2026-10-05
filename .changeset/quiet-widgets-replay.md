---
'@inflowpayai/x402-seller': minor
---

Add an opt-in Express payment-response replay helper with a caller-supplied atomic durable store. Preserve original
product bytes, status, allowed headers and settlement receipts on completed retries, serialize handler execution, and
recover staged products without rerunning handlers. Existing seller integrations remain unchanged.
