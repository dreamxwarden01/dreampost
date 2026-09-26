# Inbound gateway

This package implements the inbound gateway. It exports email, queue, scheduled, and HTTP handlers. Static mode returns 404 for HTTP requests. Dynamic mode exposes only the authenticated policy control endpoint described below. It does not configure Email Routing or catch-all rules.

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

## Opt-in dynamic recipient policies

`ROUTING_MODE=static` remains the default and uses `RECIPIENT_ROUTES_JSON`. New static receipts use delivery metadata v1. Set `ROUTING_MODE=dynamic` only after applying migration `0003_recipient_policies.sql` and upgrading the local backend to accept v2 admission evidence. Dynamic receipt never falls back to the static map, including when an address is unknown or disabled.

Dynamic mode requires:

- `POLICY_ALLOWED_DOMAINS_JSON`: an explicit JSON array of allowed domains, such as `["example.test"]`. Subdomains must be listed separately.
- `POLICY_KEYS_JSON`: a Worker secret containing a JSON map of key IDs to secrets. Every secret must contain at least 32 UTF-8 bytes and must differ from the ingestion signing secret. Retain the previous policy key during an intentional rotation window if needed.
- An authenticated backend control client using the shared protocol's `createPolicyHeaders` and `POLICY_PATH`. The endpoint accepts only `POST /internal/v1/recipient-policies`, with a maximum 16 KiB JSON body. It has no browser or user-login authentication fallback.

A policy identifies an operation, normalized recipient, immutable allocation ID, mailbox UUID, previous revision, next revision, and whether receiving is enabled. The backend numbers snapshots monotonically, and each payload names its own immediately preceding backend revision. Because each policy is a complete snapshot, the edge accepts any revision higher than its current revision, including initialization or recovery from a higher revision when intermediate operations were coalesced. Removed addresses remain as disabled policy rows retaining their last allocation target; revisions do not reset when an address is reassigned.

D1 applies the monotonic revision check and the operation's historical evidence in one transaction. A matching retry returns its original digest-bound ACK, even if later revisions have been applied. That historical ACK does not imply it is the current policy: the backend must compare the operation/revision/digest against its current desired state before changing any sending gate. Unknown stale operations, conflicting same-revision snapshots, or conflicting reuse of an operation ID return 409. A historical enable ACK cannot overwrite a newer pause snapshot. Database failures return 503 and do not produce a success ACK.

Receiving reads the primary policy, then conditionally inserts the receiving record only if that exact enabled address/allocation/mailbox/revision/digest remains current. A simultaneous pause or reassignment cannot admit a stale snapshot. A lost comparison reloads the policy up to three times; persistent races or database errors fail the handler rather than inventing a permanent SMTP rejection. Known absent/disabled policies reject while the original email handler is active.

Admitted v2 metadata preserves the original envelope spelling and permanently binds the delivery to its allocation, policy revision/digest, and mailbox. Subsequent policy changes do not redirect its retries. Old queued v1 messages continue to use their original metadata, body, and transport ACK contract even after dynamic mode is enabled. Raw recovery checks include all v2 allocation evidence.

Policy history is retained independently of completed-delivery tombstones. Do not delete that history without an explicit control-outbox reconciliation and retention design. No lifecycle API, account provisioning, or sending-permission implementation is provided by this Worker; those remain backend responsibilities.

A policy ACK confirms the D1 admission policy, not DNS configuration or upstream Email Routing delivery. This package never creates catch-all rules, adds Cloudflare routing addresses, or changes domain MX records. A local SQLite test or dry run is not evidence that the control endpoint is deployed or that a new alias receives Internet mail.
