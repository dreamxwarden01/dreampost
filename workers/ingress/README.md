# Inbound gateway

This package implements the inbound gateway. It exports email, queue, scheduled, and HTTP handlers. Static mode returns 404 for HTTP requests unless an operator endpoint or static preloading is explicitly configured. Dynamic mode exposes the authenticated policy endpoint and any explicitly configured operator endpoint described below. It does not configure Email Routing or catch-all rules.

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

`ROUTING_MODE=static` remains the default and uses `RECIPIENT_ROUTES_JSON`. New static receipts use delivery metadata v1. Set `ROUTING_MODE=dynamic` only after applying migrations through `0004_recipient_inspection.sql`, preparing the intended policies, and upgrading the local backend to accept v2 admission evidence. Dynamic receipt never falls back to the static map, including when an address is unknown or disabled.

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

## Safe static preparation

`POLICY_ALLOW_STATIC_PRELOAD=true` opts a static Worker into authenticated policy preparation. It requires policy keys, allowed domains, and a nonempty `POLICY_ALLOWED_ADDRESSES_JSON` exact-address list. Example scope: `["inbox@example.test"]`. Install the separate secrets before deploying configuration that enables these features; incomplete opted-in configuration fails validation.

Static preparation accepts only an enabled policy for an explicitly allowed existing static recipient whose mailbox matches `RECIPIENT_ROUTES_JSON`. It cannot disable static receiving or redirect it to another mailbox. Its response is HTTP 202 with `status: "prepared"`, which must not be treated as an applied PolicyAck or as evidence that v2 admission is running. The existing static handler continues creating v1 receipts. After an explicit dynamic deployment, retrying the prepared operation returns the normal HTTP 200 applied acknowledgment.

When configured, `POLICY_ALLOWED_ADDRESSES_JSON` also restricts dynamic policy writes and dynamic admission. A nonempty exact policy scope is mandatory whenever dynamic routing and operator access are both enabled. It never creates a static fallback or silently changes other configured static receiving routes. Outer Cloudflare Email Routing rules remain an independent boundary.

## Scoped operator inspection and reconciliation

The operator endpoint is opt-in: `POST /internal/v1/gateway-operations`. Configure all of:

- `OPERATOR_KEYS_JSON`, a secret JSON key ring, using credentials distinct from both ingestion and policy publication.
- `OPERATOR_ALLOWED_ADDRESSES_JSON`, a nonempty exact-recipient list. There is no wildcard or domain-wide default.
- `GATEWAY_ID`, a stable deployment identity containing 1–128 letters, digits, periods, underscores, or hyphens. It must match the identity signed into every operator request.

Use the shared protocol's gateway-operation signing helpers. Requests are limited to 16 KiB and bind the operation, intended gateway identity, request ID, timestamp, and exact request bytes. Successful responses and errors after authentication are separately signed and bind the same request ID. Clients must verify response authentication, the expected gateway/address, and freshness before using any inspection. Invalid authentication receives an unsigned 401. Responses are not cacheable.

An `inspect` operation is read-only and works in static or dynamic mode. It returns the configured mode, responding Worker version (through the optional `CF_VERSION_METADATA` binding), the effective `policyAllowedAddresses` list (`null` means no exact policy filter), static target, current D1 policy/digest, state counts, v1 pending count, active leases, and at most 50 receipt summaries per page. Summaries contain frozen mailbox/allocation evidence, body digest, state, size, and update time; they never expose bodies or sender addresses. D1 policy, counts, and the page are read in one transaction. Later pages are fresh live observations. Done counts include only tombstones still retained under the configured retention period.

Inspection is not a writer fence: it cannot observe an old Worker invocation that has not inserted its receiving record yet, prove global deployment convergence, or prove that all v1 producers have stopped. A responding version identifies that response, not every in-flight invocation. An empty backlog and elapsed time do not authorize deleting the legacy acceptance tuple or unlocking legacy lifecycle edits. The backend must retain its immutable legacy binding and lifecycle guard during the bounded dynamic-compatibility stage.

An `operation-status` operation is read-only and works in either mode. It requires the same signed request context, intended gateway identity, and exact recipient authorization, plus an operation UUID. The primary D1 lookup matches both address and operation ID. It returns a fresh signed observation with either `record: null` or the retained policy, its digest, and original `appliedAt` time. Stored identity and policy hashes are validated before returning evidence. The lookup does not publish an old snapshot, alter the current policy, retry delivery, or change admission.

Retained operation evidence can establish that a particular policy was persisted after an acknowledgment was lost, even when a newer policy is now current. It is not proof that the historical policy is currently active, that static preparation had already switched to v2 admission, or that old writers have drained. Backend recovery must match the exact planned operation and digest, and import only the verified historical evidence needed for accepted-mail validation. Inspection's effective address scope must independently match the operator's intended recipient set before confirming bounded compatibility; `null` or a broader set is insufficient.

A `reconcile` operation is dynamic-only and contains a full policy snapshot plus `expectedRemote` revision/digest. Null/null means the operator expects no current policy. The expected state is checked in the same D1 transaction as the monotonic update and applied-operation history. A stale observation or conflicting write returns a signed 409 `policy_precondition_failed`; it never silently increases the revision or overwrites a concurrent policy. A retained identical successful operation can return its historical ACK without modifying newer state. The backend still has to compare that ACK with its current local intent.

This endpoint does not retry deliveries, delete raw objects, retire legacy routes, grant mailbox access, or change Cloudflare routing. Existing Queue and scheduled repair behavior is unchanged. Rollback must preserve D1/R2 data, pending bodies, legacy receipt compatibility, and historical policy evidence; do not infer that restoring a static configuration is safe after address ownership or receiving policy changes.
