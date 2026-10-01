# Mailbox operations

This module keeps immutable delivery/MIME identity separate from personal read/star flags, shared filing/labels and derived conversation membership. See `docs/mail-api.md` for the shared client contract.

`registerMailRoutes` runs inside the application's `/api` scope. Its authentication callback must validate current SSO sessions and Origin/CSRF for mutations. The callback receives the business transaction's PostgreSQL client so principal admission happens before the mailbox lock. Development viewers have a null principal, an exact developmentMailboxId, and read-only access. `manage` is not equivalent to the `manage_messages` grant; shared changes require that grant and the `mail.manage` app permission.

Personal and filing versions are independent bigint counters, serialized as an opaque `filing:personal` string. Mutations compare only the components they change. Every changed component and its corresponding mailbox event commit together. Operations and undo receipts are actor/mailbox scoped; a repeated ID with a different payload conflicts. The undo window is 30 seconds. Undo checks the affected post-operation versions and never rewrites a later independent change. Trash does not set `deliveries.deleted_at` or delete MIME/attachments. Automatic purge is not implemented.

Messages and server-aggregated threads use keyset pagination with microsecond timestamp precision, a stable UUID tie-breaker and filter-bound cursors. `all` and `sent` exclude Trash/Spam; `sent` filters the persisted outbound direction. Cursors are locators, never authorization. Search treats wildcard characters literally and includes subject, visible From/To/Cc, extracted text and attachment filenames, with database timeouts and bounded results. A large installation may need additional indexes or a separate search implementation; there is no unbounded performance guarantee.

Conversation indexing runs under the mailbox lock. A pending conversation may initially use its delivery ID as a locator; reads resolve it to the current same-mailbox thread within the authorized snapshot, so parsing does not strand an open selection. Actual thread IDs take precedence, and foreign/deleted delivery locators return not-found. Missing-parent anchors let siblings converge before their parent arrives. Case-sensitive Message-IDs are lookup hints rather than unique message identities. Duplicate claims remain distinct; a new References chain never merges established threads. This flat membership index cannot construct a recursive parent cycle. A same-mailbox reference can still be forged: membership does not authenticate the author or give anyone access.

Before metadata-only backfill of old messages, run the existing reader-version reparse workflow. Reader version 1 did not retain ancestry. `backfillMailState` waits for version 2 records with References/In-Reply-To arrays, avoiding permanent singleton assignments from incomplete old metadata. The bounded `backfill-mail.ts --limit 100` command reports indexed records and records awaiting reader metadata. Ingestion initializes filing state; parser completion indexes conversations in its existing business transaction. Neither helper opens its own transaction.

The PostgreSQL mailbox change log remains authoritative. SSE polls bounded replay pages every second, emits sequence-only invalidations, rechecks a durable source-session reference and mailbox membership, and closes on expiry/revocation. It does not renew idle expiry. Personal events are filtered by actor, including replay. Connections are capped at four per principal and 100 per process, with a five-minute lifetime and immediate closure on backpressure. These process limits are operational bounds, not a global distributed quota. Missed notifications and reconnects recover from the durable sequence. A retired event-history cursor requires reset. Event or idempotency retention cleanup is not automatically enabled.

Focused verification:

```sh
node --env-file=.local/dev.env node_modules/vitest/vitest.mjs run apps/api/test/mail.integration.test.ts
pnpm --filter @dreampost/api typecheck
```

The integration suite creates/drops a unique PostgreSQL schema and starts only an ephemeral loopback HTTP server for SSE. It does not apply migrations to the live schema or access real mail.
