# DreamPost

A self-hosted mailbox with a local backend, an English web client, and Cloudflare email delivery.

DreamPost keeps mail storage and access control under your control. Cloudflare handles inbound email routing and outbound delivery; the backend owns mailboxes, addresses, permissions, and message history. Core mail features work without an AI agent.

**Status:** active development. Production operations, automated spam filtering, storage quotas, and large-file sharing are still in progress.

## Features

- Conversations, search, folders, labels, read/star state, and bulk actions with undo.
- Autosaved drafts, replies, reply-all, forwarding, and ordinary attachments.
- Self-To/Cc/Bcc copy grouping, with Inbox and Sent entry points and preserved originals.
- Isolated HTML reading, external-image controls, and PDF/image previews.
- DreamSSO (OIDC-based) sign-in, mailbox access controls, address requests, and sending-identity checks.
- Durable inbound delivery and outgoing queues with explicit retry and failure handling.

## Architecture

- **Web:** React and TypeScript.
- **Backend:** Node.js, PostgreSQL, and local raw-mail storage.
- **Email gateway:** Cloudflare Email Routing and Workers, with temporary R2 staging and signed delivery to the backend.
- **Attachments:** private R2 storage with authenticated Worker downloads.
- **Sending:** a provider interface with a Cloudflare REST adapter.

DreamSSO is a separate service and is not bundled here; other identity providers are not currently supported. Composing and sending require SSO mode. The development bearer-token viewer is read-only.

Hostnames, credentials, and provider limits are deployment configuration.

## Development

Requires Node.js 24, pnpm 10.33.2, and PostgreSQL. Docker Compose configuration is included for local services.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Database integration tests use `TEST_DATABASE_URL` and isolated schemas. Live email delivery requires separately configured provider credentials, recipient routing, and sender permissions.

AI assistance, native clients, and additional sending providers are planned extensions, not requirements for the basic mailbox.

## Documentation

- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Mail API](docs/mail-api.md)
