# Development

Use Node.js 24 and pnpm 10.33.2. CI uses Node.js 24 and PostgreSQL 17. Install Docker with Compose, or provide an existing PostgreSQL 17 server. Redis is included in Compose but is not currently used by the application or required for local mail development.

## Read-only local inbox

The setup helper creates `.local/dev.env` with independently generated secrets and a mailbox UUID. It refuses to overwrite an existing file. The root package scripts use this file; they do not automatically read `.env.local`.

```sh
pnpm install --frozen-lockfile
pnpm setup:local inbox@example.test
pnpm build:protocol
docker compose --env-file .local/dev.env up -d postgres
pnpm db:migrate
pnpm db:seed
```

With an existing database, set `DATABASE_URL` in the generated file and omit the Compose command. `MAIL_STORE_PATH` selects the local raw-mail directory. The generated file sets `PUBLIC_BASE_URL=http://localhost:5173`. `OUTBOUND_PROVIDER=disabled` is valid and is also the default when omitted. No provider credential is needed for this read-only setup.

Run each process in its own terminal:

```sh
pnpm dev:api
pnpm jobs
pnpm dev:web
```

Open `http://localhost:5173`, enter the generated `DEV_VIEW_TOKEN` in **Development view token**, and choose **Connect to mailbox**. The browser sends it as an Authorization bearer header, holds it only in the tab's memory and clears it on disconnect or reload. This mode cannot compose, send or change mailbox state. An empty mailbox is expected until mail is ingested.

Vite proxies the API to `http://127.0.0.1:3001`; `DEV_API_TARGET` overrides that address. If maintaining a different ignored env file, such as `.env.local`, run the underlying command with that file instead, for example `node --env-file=.env.local --import tsx apps/api/src/server.ts`. Root shortcuts continue loading their named `.local/*.env` files.

## DreamSSO sign-in

DreamSSO is the only supported identity provider. It is a separate service, not bundled with this repository. The integration depends on its application-role, registration and signed backchannel-event contracts; arbitrary OIDC providers are not currently supported. Composing and sending require SSO mode, the relevant permissions and a current sending-address grant.

Generate a client configuration for an HTTPS origin without a non-default port:

```sh
pnpm setup:sso --issuer https://sso.example.test --client-id dreampost-dev \
  --public-base-url https://mail.example.test --domain example.test
pnpm sso:registration
```

The helper writes the private key and `.local/sso.env`; it does not register the client. Start `pnpm dev:api:sso` instead of `pnpm dev:api` and make the configured public JWKS, callback and event endpoints reachable. Register the emitted public material with DreamSSO, then run `pnpm sso:sync` to publish the role catalog before login. The SSO env file supplies `AUTH_MODE=sso`, issuer/client/key settings and managed mail domains.

## Email transport

Ingress requires Cloudflare Email Routing, D1, R2, Queues and configured signing secrets. Checked-in Wrangler resource IDs and addresses are examples. Local API startup does not provision cloud resources or configure DNS.

To enable sending, configure `OUTBOUND_PROVIDER=cloudflare`, a dedicated `OUTBOUND_CF_ACCOUNT_ID` and `OUTBOUND_CF_API_TOKEN`, provider/domain setup and authorized sender grants. Run `pnpm jobs:outbound` to dispatch queued messages; starting it is not a read-only configuration check. This command loads `.local/dev.env`, `.local/sso.env`, and optional `.local/attachments.env` and `.local/outbound.env`, in that order. If outbound settings are kept in `.local/outbound.env`, load that overlay into the API process too: `dev:api:sso` does not read it automatically. Keep the applicable attachment overlay when using ordinary attachments.

## Attachments and previews

This is a separate integration from the HTTP-only inbox quickstart. Use named HTTPS origins with local DNS/hosts entries and trusted TLS termination. The browser fixture uses `mail.example.test`, `download.example.test` and `preview.example-isolated.test`, routed to loopback over HTTPS. Mail and downloads have distinct hostnames on the same site; preview has a different site. Set `PUBLIC_BASE_URL` to the mail origin, and set `DEV_PUBLIC_HOSTNAME=mail.example.test` when running Vite behind that hostname.

```sh
pnpm setup:attachments --app-origin https://mail.example.test \
  --download-origin https://download.example.test \
  --preview-origin https://preview.example-isolated.test
```

The helper accepts HTTPS only and generates `.local/attachments.env` plus a separate Worker secret; it does not deploy the Worker, bucket or DNS. Configure the Worker with its private R2 binding, request limiter, origins and `/internal/v1/attachments/control` callback. Keep these settings aligned:

| API setting | Download Worker setting |
| --- | --- |
| `DOWNLOAD_KEY_ID` | `CONTROL_KEY_ID` |
| `DOWNLOAD_SECRET` | `CONTROL_SECRET` |
| `DOWNLOAD_MAX_SESSIONS` | `MAX_DOWNLOAD_SESSIONS` |
| `DOWNLOAD_MAX_PENDING_SESSIONS` | `MAX_BOOTSTRAP_CHALLENGES` |

Use the same attachment key ID/secret on both sides; do not reuse ingestion or SSO credentials. The generated session/pending defaults are 16/4. Start the API with the attachment env overlay and run the job command in another terminal:

```sh
node --env-file=.local/dev.env --env-file-if-exists=.local/sso.env \
  --env-file=.local/attachments.env --import tsx apps/api/src/server.ts
pnpm jobs:attachments
```

Build preview with `PREVIEW_PARENT_ORIGINS` set to the exact HTTPS mail origin and serve its emitted security headers. If using its Vite server behind a named host, also set `PREVIEW_PUBLIC_HOSTNAME` to that hostname.

Local test exceptions are separate: API `ALLOW_INSECURE_LOCAL_DOWNLOAD=true` permits loopback HTTP origins; Worker `ALLOW_INSECURE_LOCAL=true` permits loopback HTTP URLs, including its backend callback. They do not form a supported all-HTTP attachment setup: the API requires distinct hostnames, while the Worker's HTTP allowlist and same-site check cannot satisfy that layout together. Use the named HTTPS arrangement for browser testing; the Worker flag can allow its private loopback HTTP callback while browser origins remain HTTPS.

## Verification

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database whose role can create and drop schemas. The integration suites create their own schema, select it through `search_path` and drop it afterward. The setup helper points `TEST_DATABASE_URL` at the development database for this purpose; that shared database is suitable only for disposable development data. Use a separate database and ignored `.env.test` when the development database contains real mail. PostgreSQL suites are skipped if the variable is absent.

```sh
pnpm typecheck
node --env-file=.env.test node_modules/vitest/vitest.mjs run
pnpm build
pnpm --filter @dreampost/ingress dry-run
```

Alternatively, `pnpm test:integration` loads the generated `.local/dev.env`; `pnpm test` uses the current process environment. Both build the protocol package before Vitest. CI supplies `TEST_DATABASE_URL` and runs typechecks, tests, builds and an ingress dry run without deploying resources.

Browser fixtures use synthetic identities and generated mail. After building the web application, install a matching browser with `pnpm exec playwright install chromium` (on Linux, use `pnpm exec playwright install --with-deps chromium` when system libraries are needed), then run `node --env-file=.env.test --import tsx tests/everyday-browser.ts`.

Keep environment files, keys, database dumps, raw mail and fixture output out of version control. Back up PostgreSQL and the raw-mail store together before migrations; API and job processes must use compatible schema and application versions.
