# Inbound gateway

This package implements the inbound gateway. It exports email, queue, and scheduled handlers, has no public HTTP handler, and does not configure Email Routing or catch-all rules.

`RECIPIENT_ROUTES_JSON` maps explicitly configured SMTP recipients case-insensitively to configured mailbox UUIDs. The checked-in configuration uses only `example.test`. Use an ignored deployment configuration for real resources and a recipient you control and are authorized to test. Set `INGEST_SECRET` through Worker secrets. The backend URL must be HTTPS and end in `/internal/v1/deliveries`. Local development can explicitly enable HTTP for loopback hosts with `ALLOW_INSECURE_LOCAL_BACKEND=true`.

The receipt order is D1 `receiving`, complete raw MIME plus recovery metadata in R2, D1 `stored`, and a Queue wake-up. An enqueue failure after storage is recoverable by the scheduled handler. Once R2 confirms complete storage, a D1 finalization failure or lost lease returns normally and leaves the receiving record for repair. Failures before confirmed raw storage still surface as handler errors; this does not promise a particular SMTP error or automatic retry behavior.

Delivery takes a conditional lease, verifies stored bytes and metadata, and generates fresh signed headers. Only HTTP 200 with a matching durable ACK permits `delivered_pending_delete`. Cleanup deletes the R2 object and retains a small `done` ledger tombstone. Requests use manual redirect handling and never follow redirects. Their timeout grows from 30 seconds by one second per 256 KiB, up to 150 seconds; leases last 300 seconds.

Transient HTTP/network failures, 401/403 authentication errors, redirects, unknown responses, malformed JSON, and mismatched ACKs retry with bounded exponential backoff. Only recognized deterministic backend error codes paired with their documented 400/409/413/415/422 statuses, or local raw-data integrity failures, become `blocked` records with the body retained. They require investigation and explicit reactivation after the cause is fixed. The gateway logs sanitized codes but does not yet implement an independent alert channel or administration UI. Do not treat this as production-ready monitoring.

Scheduled repair recovers interrupted receipts with complete R2 objects, re-enqueues due stored records (including lost or expired queue pointers), recovers expired leases, and retries cleanup. It never deletes pending bodies merely because they are old. Missing raw data remains visible as a failed receipt requiring investigation. Malformed data is blocked. A DLQ is diagnostic, not authoritative; its entries may expire without deleting raw mail.

The original envelope recipient remains unchanged in signed metadata. Configuration rejects case-folded route keys mapped to conflicting mailbox IDs.

Completed ledger tombstones expire after `DONE_RETENTION_DAYS` (default 7, allowed 1–3650). Scheduled cleanup removes at most 100 old `done` records per run, only after raw cleanup has completed. It never removes receiving, stored, blocked, or unfinished-cleanup records.

Do not attach automatic expiry to pending raw objects. Backlog byte budgets, operator alerts, and production cutover gates remain follow-up work. No native rate-limit binding or Durable Object is used.

After installing root workspace dependencies and building the protocol package:

```sh
pnpm --filter @dreampost/ingress typecheck
pnpm exec vitest run workers/ingress/test
pnpm --filter @dreampost/ingress dry-run
pnpm --filter @dreampost/ingress db:migrate:local
```

Unit tests exercise recovery and concurrency with fake services. A Wrangler dry run and local D1 migration validate packaging/schema but cannot establish real SMTP acceptance, Email Worker exception behavior, source-authentication evidence, or cross-service guarantees. Those require a recipient you control and are authorized to test, together with explicit deployment configuration.
