# Mail API contract

All paths below are under `/api`. SSO mutations require a current session and Origin/CSRF checks. Development-token access is read-only.

## Shared representations

MailAddress is `{name:string,address:string}`. The backend parses original MIME; the frontend never splits display-header strings to determine reply recipients. Resource IDs use CSPRNG UUIDs. Sequence counters cross JSON as decimal strings. Draft revisions are positive safe integers; message state versions are opaque `filing:personal` strings.

MessageSummary retains `id,subject,from,to,receivedAt,preview,status,sizeBytes` and adds `threadId:string|null,direction:inbound|outbound,read,starred,folder:inbox|archive|trash|spam,labelIds:string[],version:string`. Direction is independent of filing; outbound Sent copies start in archive and the Sent view selects outbound copies excluding trash/spam.

ThreadSummary is `{id,subject,preview,receivedAt,from,to,messageCount,matchedCount,unreadCount,starred,lastMessageId}`. Do not expose Bcc or a historical recipient union as an access or reply list.

## Mail operations

- GET /mailboxes/:id/messages supports `view=messages|threads`, `limit` (default 50, maximum 100), keyset `cursor`, `folder=inbox|archive|trash|spam|sent|all`, `unread`, `starred`, `labelId`, and bounded literal query `q`. Response has `view,messages?,threads?,nextCursor:string|null,changeSequence:string` and mailbox capabilities where needed. Existing message detail/render/raw paths remain valid; detail can include additional state/thread fields.
- GET /mailboxes/:id/threads/:threadId returns only visible same-mailbox messages, with bounded pagination.
- POST /mailboxes/:id/messages/mutate takes `{operationId,items:[{id,version}],set?:{read?,starred?,folder?},addLabelIds?,removeLabelIds?}` (maximum 100 items). Response has `{operationId,messages:[{id,threadId,read,starred,folder,labelIds,version}],changeSequence,undoUntil}`. Compare only changed version components; all-or-nothing validation/commit. Per-principal read/star require read access. Filing/labels require both mail.manage and manage_messages.
- POST /mailboxes/:id/operations/:operationId/undo is actor/mailbox scoped and atomically refuses changed post-operation versions. No automatic raw deletion.
- GET/POST /mailboxes/:id/labels and PATCH/DELETE /mailboxes/:id/labels/:labelId provide bounded mailbox-wide label management; mutations require mail.manage/manage_messages and idempotency.
- GET /mailboxes/:id/changes?after=<sequence>&limit=500 and GET /mailboxes/:id/events provide scoped replay/invalidation. The changes endpoint defaults to 500 records and permits at most 500 per page. Personal events are visible only to their actor. SSE validates source session/membership without idle renewal and closes on revocation/expiry. No mailbox content appears in event payloads.

Application permissions and mailbox/address grants are checked independently. Administration alone does not grant access to mailbox contents.

## Drafts and sends

Draft is `{id,mailboxId,authorPrincipalId,version:number,state:editing|queued|discarded,mode:new|reply|reply_all|reply_person|forward,sourceMessageId:string|null,fromAllocationId:string|null,to:MailAddress[],cc:MailAddress[],bcc:MailAddress[],subject,bodyText,quote:null|{sourceMessageId,sourceContentVersion,sourceSha256?,include,attribution:{from,to,cc,subject,sentAt},text},attachments:DraftAttachment[],updatedAt,warnings:string[]}`. DraftAttachment is `{id,filename,mimeType,sizeBytes,sha256}`. Quote content is server-owned; a PATCH may toggle includeQuote, not forge source headers or raw quoted HTML.

- POST /mailboxes/:id/drafts takes `{mode,sourceMessageId?,replyPerson?:MailAddress,fromAllocationId?,mutationKey}` and returns `{draft}`. GET lists author-owned active DraftSummary values: id,mailboxId,version,state,mode,subject,updatedAt, first three To entries,recipientCount,attachmentCount; no full body/quote. Creating replies/forwards checks the same-mailbox source; bodyText starts empty.
- GET/PATCH /mailboxes/:id/drafts/:draftId. PATCH includes `{expectedVersion,mutationKey}` and changed editable fields (fromAllocationId,to,cc,bcc,subject,bodyText,includeQuote). Idempotency keys are CSPRNG UUIDs. Conflicts return 409 without overwriting another tab.
- POST /mailboxes/:id/drafts/:draftId/duplicate takes mutationKey and creates a separately owned editing copy with fresh attachment IDs. A queued/dispatching/accepted/partial/unknown original adds duplicate_delivery_possible and requires explicit acknowledgement before sending the copy.
- POST /mailboxes/:id/drafts/:draftId/discard takes expectedVersion/mutationKey.
- POST /mailboxes/:id/drafts/:draftId/attachments accepts bounded application/octet-stream and headers x-draft-version,x-attachment-filename (percent-encoded UTF-8),x-mutation-key. Return updated draft; attachment mutations increment draft version. PDF/raster media types use server-side byte recognition, with octet-stream fallback. DELETE the attachment path requires expectedVersion/mutationKey.
- POST /mailboxes/:id/drafts/:draftId/attachments/copy accepts `{expectedVersion,mutationKey,sourceMailboxId,sourceMessageId,sourceAttachmentId}`. Source authorization/content correspondence is checked before snapshot-owned bytes are created; currently limited to the same mailbox. Forward may copy ordinary attachments through this same checked path.
- POST /mailboxes/:id/drafts/:draftId/send takes `{expectedVersion,mutationKey,acknowledgeNotVisible?,acknowledgeDuplicate?}` and returns `{submission}`. It atomically freezes the exact draft revision, all visible content/recipient arrays and private Bcc envelope metadata, marks the draft queued, and rejects later autosaves.
- GET /mailboxes/:id/outbox and GET /mailboxes/:id/outbox/:submissionId are author-scoped unless an explicit later management permission exists. POST /mailboxes/:id/outbox/:submissionId/cancel is versioned/idempotent and only affects work not admitted for dispatch.

The final fresh dispatch admission uses one documented sorted-principal -> mailbox -> registry/allocation/grant -> outbox order, records a durable dispatching attempt, commits, then immediately invokes one bounded provider request outside hot mailbox locks. Expired/stale starts do not call the provider. Unresolved dispatching attempts become unknown and are never replayed automatically. Authorization failures are terminal blocked states; old snapshots do not resume on unpause/regrant. All recipients use the same provider/gate, with no hidden internal bypass or chunking. Submitted and Sent MIME omit Bcc; the author-private outbox snapshot retains Bcc recipients without exposing them to thread summaries or Reply all.

## Source identity and resource behavior

Sources bind to raw SHA-256 across parser upgrades. Quote text is not silently rewritten; source access/tombstone and complete attachment tuples remain checked at freeze. Metadata awaiting parsing produces source_preparing; no raw MIME parsing occurs within those write locks. Read-only draft/outbox queries do not lock principals/mailboxes or extend sessions during background polling. Sent parsing and attachment reconstruction precede the final write transaction.

Successful PATCH replaces older PATCH receipts for that draft. Superseded expected versions still fail CAS; create/duplicate/send receipts retain their bounded seven-day identity window. Inherited presentation controls/oversized names are normalized with a warning; unsupported address chips remain editable and must pass strict envelope validation before Send. Browser autosave retries ambiguous/network/429/5xx errors with the same request key and capped backoff.

## Verified copy projection

Message and conversation GET endpoints accept `groupCopies=true`. Without explicit opt-in they retain legacy per-delivery state, action targets and cursor hashes. Grouped summaries add `copyGroupId` and authorized folder-visible `copies` entries containing only id, version, folder, read, starred, direction and labelIds. The top-level resource ID/version still identify an actual representative; read/star and labels summarize visible copies. Clients must use each targeted copy's opaque version for mutations, not the representative version for the whole group. The grouped cursor contract is separately versioned.

Mailbox and folder visibility precede grouping; read/star filters use logical flags and copy JSON is expanded only for the bounded page. Default conversation opens include visible context from Inbox/Sent while excluding Trash/Spam, and original copy resources remain independently authorized.
