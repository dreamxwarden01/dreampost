# Private attachment download Worker

This package implements the dedicated attachment byte service. PostgreSQL/backend code remains the authority for users, mailbox membership, share policy, one-time tickets, session hashes, and transfer records. `ATTACHMENTS` is private long-term R2 storage, separate from inbound raw-mail staging. No public R2 domain or `r2.dev` route is required.

## Endpoints

| Endpoint | Authentication and result |
| --- | --- |
| `POST /bootstrap/challenge` | Exact configured app Origin, JSON `{flowId}`. Prunes backend-confirmed dead session cookies, then sets an independent 32-byte CSPRNG HttpOnly challenge cookie and returns `{flowId,challengeHash}`. |
| `POST /bootstrap/redeem` | Same Origin requirement, JSON `{flowId,ticket}` and the exact flow's challenge cookie. Sends only challenge/session-secret hashes to the backend. Sets a uniquely named download-session cookie and returns `{sessionId,transferId,purpose,expiresAt,url}`. |
| `GET/HEAD /sessions/:sessionId/transfers/:transferId` | Exact session cookie, fresh signed backend authorization, immutable R2 size/checksum/metadata validation, then streaming bytes. |
| `PUT /internal/v1/objects/:attachmentId` | Download-machine HMAC headers, exact signed size/digest, maximum 25 MiB. R2 conditional creation with SHA-256 validation; matching existing objects are acknowledged without overwrite. Zero-byte objects work. |
| `OPTIONS` for browser endpoints | Exact app Origin and path-specific method/header allowlists; does not grant access or set a cookie. |

All other routes and query strings fail closed. Identifiers are lowercase UUIDs; they identify records and are not bearer credentials. No endpoint serves HTML or JavaScript. The browser flow uses credentialed same-site CORS requests, not a popup, iframe, or ticket query string.

The backend's ticket-creation route must check the current source session/share authorization, Origin and CSRF, and bind the exact flow, challenge hash, purpose and transfer. On challenge, the Worker submits at most 32 unique session IDs and credential hashes to the signed `prune` operation. The backend must classify dead/expired/revoked/invalid-source sessions without accepting IDs as proof. The Worker verifies that returned dead IDs are a subset of the request, clears only those cookies (plus malformed owned values), and preserves every active/unreported session. Failure, invalid reply or 503 clears nothing. An excessive list is rejected rather than truncated; surviving sessions still count toward the configured cap.

The backend must atomically consume a ticket and count both pending and active sessions against separate bounded limits. A lost redemption response requires a new flow/session; unused sessions expire quickly and do not bypass caps. These backend obligations cannot be enforced solely from browser cookie counts.

## Configuration

Required: `APP_ORIGIN`, `DOWNLOAD_ORIGIN`, `BACKEND_CONTROL_URL`, `CONTROL_KEY_ID`, and secret `CONTROL_SECRET`. The control URL must have the exact path `/internal/v1/attachments/control` and no query/fragment. Use a newly generated independent machine secret with at least 32 CSPRNG bytes; never reuse ingestion, SSO, policy, or operator secrets. The shared protocol separates request/reply and control/upload purposes and binds method, exact path, nonce, timestamp, status where applicable, and raw body digest.

The origins must be distinct and on the same HTTPS site. Site validation uses `tldts` with private suffixes, so unrelated tenants under `github.io` are not considered same-site. `ALLOW_INSECURE_LOCAL=true` permits HTTP only on literal `127.0.0.1` or `localhost`; local cookie names deliberately omit `__Host-`/Secure. This is an explicit synthetic-development option, not a production fallback.

`MAX_DOWNLOAD_SESSIONS` defaults to 16 (maximum 32), and `MAX_BOOTSTRAP_CHALLENGES` to 4 (maximum 8). These limit cookies seen by this Worker; authoritative backend caps remain necessary. Challenge cookies expire after 120 seconds. Production names are `__Host-dp-bootstrap-<flowId>` and `__Host-dp-download-<sessionId>`, with Secure, HttpOnly, SameSite=Lax, Path=/, and no Domain. Main-application/SSO cookies must also be host-only. The parser recognizes only the active secure/local session and bootstrap prefixes followed by a valid lowercase UUID. It ignores unrelated malformed/duplicate cookies and invalid UUID suffixes, rejects duplicate owned names even with identical values, and validates the selected credential value before authorization. The total Cookie header remains capped at 16 KiB; unrelated cookies do not bypass that resource bound.

`wrangler.jsonc` contains example resources/origins only. Copy `.dev.vars.example` into ignored local configuration and replace placeholders with independently generated test secrets. Do not deploy that example as a live resource definition.

## Request-start abuse protection

A `REQUEST_START_LIMITER` Workers Rate Limiting binding is required for protected requests. The example uses a separate account namespace with 600 starts per 60 seconds per Cloudflare location; choose an unused namespace when deploying and tune the limit for the expected PDF Range workload. It is a Workers binding, not a WAF custom rule. No subscription or cloud change is performed by this package.

The limiter runs before bootstrap body processing, backend authorization calls, and R2 uploads/reads. Exhaustion returns 429 with a conservative Retry-After: 60; a missing, throwing, or malformed binding fails closed with 503. CORS preflights do not authorize data or call the backend. Existing admitted streams are unaffected.

Before authentication, the coarse client key is derived from Cloudflare's inbound CF-Connecting-IP; cookie values, session/transfer IDs, paths, and client-supplied forwarding headers cannot create fresh budgets. Missing/malformed addresses share one unknown-client bucket. A NAT may put multiple legitimate users in the same budget, while multiple source addresses/locations can obtain separate budgets. This is an abuse mitigation, not a user identity, strict quota, global concurrency limit, or exact accounting mechanism. Cloudflare explicitly documents the binding as location-local, permissive, and eventually consistent. Backend authorization, pending/active-session caps and any strict quotas remain required. See [official binding documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

`ALLOW_LOCAL_RATE_LIMIT_BYPASS=true` is a separate explicit test-only option. It is rejected unless ALLOW_INSECURE_LOCAL is also true and all configured app/download/backend hosts are literal localhost or 127.0.0.1. HTTPS browser tests uses the real Miniflare rate-limit binding; it needs no bypass. The shared fixture defaults to the same 600/60 limit and accepts an explicit synthetic requestLimit override for admission-boundary tests.

## Authorization and continuation

The Worker calls the backend on every new GET, HEAD and conditional/range request. The callback sends `requestOrigin` so a preview transfer is rejected before backend activation unless it comes from the configured app origin. The Worker independently checks the returned purpose and session/transfer identities. Backend redirects, unsigned/mismatched/oversized responses, invalid signatures and unavailable callbacks never release R2 bytes.

Redemption returns the short first-use deadline. The first successful authorization activates the backend session and returns its fixed absolute `sessionExpiresAt`; the Worker sets the same cookie name/secret with the remaining lifetime. It never extends the backend absolute deadline or rotates another session's secret. Authorized byte/HEAD responses expose `X-DreamPost-Session-Expires-At` in milliseconds through CORS so the UI can replace the initial first-use deadline with the confirmed fixed session lifetime. Only a signed backend 401 clears the targeted session cookie; temporary failures do not erase it.

A grant is checked again after asynchronous R2 operations and before body admission. An admitted stream is not aborted when that grant later expires. Every later request needs fresh authorization. Interruptions, client disconnects and runtime updates can still stop transfers; the implementation does not promise universal native-browser resume or exact global concurrent-download accounting.

## Bytes, integrity, and headers

Keys are `attachments/<attachmentId>/<sha256>`. A write uses R2's atomic create-only condition; there is no head-then-unconditional-put fallback. Existing-object acknowledgments and reads require actual R2 SHA-256 checksum, size, key and matching custom attachment identity/digest. The backend should mark a file ready only after checking the signed matching upload acknowledgment.

GET supports one byte range, open-ended and suffix ranges, exact 206/416 metadata and strong ETag `"sha256-<hex>"`. HEAD ignores Range and returns full metadata without reading the body. If-None-Match and If-Match are evaluated after authorization. If-Range uses the strong ETag; a mismatch, weak validator or date validator falls back to a full 200 because this endpoint does not emit Last-Modified. Multi-range/invalid requests are rejected. An empty object returns Content-Length 0; any range against it is unsatisfiable.

Files stream from R2 without whole-file buffering. Responses use attachment disposition with a sanitized ASCII filename plus UTF-8 filename*, nosniff, no-referrer, CSP `default-src 'none'; sandbox`, and `Cache-Control: no-store, no-transform`. Only PDF, common raster types and text/plain retain their declared Content-Type; others use application/octet-stream. No shared byte cache is implemented.

## Verification

```sh
pnpm --filter @dreampost/protocol build
pnpm --filter @dreampost/downloads typecheck
node node_modules/vitest/vitest.mjs run packages/protocol/src/downloads.test.ts workers/downloads/test/downloads.test.ts
pnpm --filter @dreampost/downloads test:workerd
```

The last command bundles without deployment and runs the actual Worker in local Miniflare/workerd with ephemeral R2. It covers checksum rejection, create-only idempotency, metadata, empty objects, real bootstrap, GET/HEAD/ranges/conditionals, and bare-URL denial. `test/miniflare-fixture.mjs` exports `createDownloadsMiniflare({bindings,outboundService})` for the combined browser/API tests; unspecified outbound traffic is denied. Callers must dispose it. Miniflare's Headers use a different realm, so Node-side protocol test adapters should normalize them with `new Headers([...headers])`.

No test sends real mail, uses live Cloudflare resources, or reads actual user credentials. Local emulation is not a substitute for separately authorized live capability/deployment checks.
