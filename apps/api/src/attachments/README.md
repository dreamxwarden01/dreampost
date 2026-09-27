# Attachment manifest repair

This module handles ordinary received-MIME attachments. The first committed inventory records its extractor version, options digest and full ordered source tuples: ordinal, decoded-byte SHA-256, byte length, declared MIME type, disposition, original filename and Content-ID. Attachment IDs, source correspondence and the original extraction provenance are immutable.

General backfill schedules only messages that do not yet have a manifest. It does not reparse an established inventory merely because the extractor version changed. Existing pending work can finish, and an explicit missing-staging repair can use a newer extractor only when both the complete ordered tuples and their manifest digest still match. Compatible repair reuses the same IDs, object keys and physical reservations, without rewriting the original version/options record. Any correspondence change marks drift; it cannot overwrite or remap existing ready objects.

The isolated extractor remains pinned to PostalMime 3.0.1. Its guarded calendar adapter reads the pinned parser's decoded MIME leaves because the public attachment API normalizes calendar charset and newlines. The options descriptor includes `calendarBytes: decoded-leaf-v1`. Exact-byte tests cover CRLF, non-UTF-8 calendars, duplicates and calendars inside opaque attached messages. Dependency changes require reviewing this private-tree correspondence; this implementation neither interprets calendar semantics nor extracts PDF document text.

## Retrying exhausted local staging I/O

After correcting the local filesystem problem, a privileged operator can retry an extraction job that exhausted its five attempts while writing staged bytes. This is distinct from missing queued-file recovery, which the uploader schedules automatically. Read the exact job and manifest metadata first; do not inspect or parse attachment contents:

```sql
SELECT j.delivery_id, j.status, j.attempts, j.last_error_code,
       to_char(j.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS failed_at,
       i.status AS inventory_status, i.manifest_sha256,
       count(*) FILTER (WHERE o.state = 'staging') AS staging_objects
FROM attachment_extraction_jobs j
JOIN attachment_inventories i ON i.delivery_id = j.delivery_id
JOIN message_attachments a ON a.delivery_id = j.delivery_id
JOIN attachment_objects o ON o.id = a.attachment_id
WHERE j.delivery_id = '<delivery UUID>'::uuid
GROUP BY j.delivery_id, j.status, j.attempts, j.last_error_code, j.completed_at, i.status, i.manifest_sha256;
```

From the repository root, supply the observed immutable manifest digest, failed attempt count and exact microsecond failure timestamp:

```sh
node --env-file=.local/dev.env --import tsx apps/api/src/commands/retry-attachment-staging.ts --delivery-id <delivery-uuid> --manifest-sha256 <observed-manifest-sha256> --expected-attempts 5 --failed-at <observed-failed-at> --operator <maintenance-label>
```

The command schedules work only. Run the normal attachment jobs afterward. Retain its metadata-only JSON receipt with your operational records; the label identifies the local operator and is not an application-user impersonation. The receipt is command output, not a new database audit ledger. A repeated or stale request exits with code 2 and cannot reset a newer attempt. The failure timestamp prevents an old command from matching a later exhausted cycle with the same attempt count.

Eligibility is deliberately narrow: a nondeleted message, failed extraction job, unavailable inventory, matching failure timestamp, attempt count and manifest digest, at least one object still staging, and the specific `attachment_staging_io_unavailable` error recorded for a known filesystem I/O failure. Drift, digest corruption, raw-source read failures, parser/resource failures, active leases, upload conflicts and already-ready objects are not reset. The existing manifest, parser provenance, attachment IDs, object keys and capacity reservations remain unchanged; normal byte/digest/correspondence checks still run before staging or readiness. General backfill remains unable to bypass this boundary.
