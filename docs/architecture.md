# Architecture

DreamPost is a self-hosted mail application with a local backend and Cloudflare email transport. PostgreSQL and the local raw-mail store retain application state and original messages. Basic mail operations do not require an AI service.

## Components

| Component | Responsibility |
| --- | --- |
| `apps/web` | Mailbox UI, conversations, message reading, drafts and composing. |
| `apps/api` | Authentication, mailbox authorization, message storage, mail operations and background jobs. |
| `packages/protocol` | Shared data types and signed machine-to-machine protocols. |
| `workers/ingress` | Cloudflare Email Routing admission, durable receipt tracking and delivery retries. |
| `workers/downloads` | Authorized streaming of private R2 attachments, including byte ranges. |
| `apps/preview` | Isolated PDF and raster-image rendering through a bounded byte bridge. |

## Receiving and storage

1. Cloudflare Email Routing passes mail to the ingress Worker. Recipient policies determine which addresses and mailboxes can receive it; catch-all routing does not itself create a wildcard inbox.
2. The Worker retains raw mail in R2, records delivery state in D1 and schedules delivery through a queue. Its repair path can retry unfinished deliveries.
3. A signed request sends the original MIME to the local API. The API checks the recipient binding, durably writes a content-addressed raw file and commits the receipt and parse job in PostgreSQL before acknowledging it.
4. A separate job parses the stored message. The Worker removes its temporary raw object after a verified durable acknowledgement.

Delivery IDs and content digests support idempotent retries. Reusing a delivery ID with different content or metadata is a conflict. Parsing and attachment extraction can be retried without accepting another delivery or rewriting the original MIME.

Attachments are extracted through bounded jobs. When attachment storage is configured, immutable objects are uploaded to a private R2 bucket. PostgreSQL stores their identity, status and mailbox association; the original MIME remains local.

## Identity and access

SSO mode supports DreamSSO using OIDC Authorization Code with PKCE, signed client authentication, server-side sessions and verified backchannel events. DreamSSO is a separate service, not bundled here. Its application-role and event contracts are required; other identity providers are not currently supported.

Application permissions and mailbox membership are separate. Reading a mailbox requires an active membership; administration permissions alone do not grant access to its contents. Sending additionally requires a current grant for the selected address. Address ownership, receive policies and historical allocations belong to DreamPost.

The development mode uses a fixed-mailbox bearer token and provides read-only access. It does not substitute for multi-user SSO authorization.

Read and star flags are per principal. Filing and labels are shared mailbox state and require message-management permission. Mutations use version checks and bounded undo records. Drafts and outbox details, including Bcc, remain scoped to their author.

## Sending and conversations

Drafts are saved with optimistic concurrency control. Sending freezes one MIME snapshot in a durable outbox and rechecks address authority before the provider request. Cloudflare Email Sending is the implemented transport; there is no SMTP transport.

Provider acceptance is distinct from recipient delivery. An uncertain provider outcome is retained as unknown and is not automatically resent. Saving a Sent copy is a separate local operation.

An explicit provider RFC Message-ID can supplement the immutable local header for threading. Generic tracking receipts do not establish message identity. Verified self-copies can share one conversation card while preserving separate deliveries, raw files and filing state. This requires accepted-outbox, recipient, mailbox and complete-content evidence; matching a subject or Message-ID alone is insufficient.

## Browser boundaries

HTML mail is sanitized and displayed in a sandboxed frame. Remote images are blocked by default; loading them is an explicit user choice or personal preference. Direct remote-image loading can disclose a request to the image host.

Ordinary attachment access uses short bootstrap grants and narrowly scoped download-session cookies. The download Worker asks the backend to authorize new requests and streams bytes from private R2. Preview content runs on a separate site from mail and downloads, with no application credentials passed to the renderer.

Large-file sharing, automated spam classification and an AI automation layer are not provided by this architecture's current mail workflow.
