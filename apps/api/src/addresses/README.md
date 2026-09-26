# Address service boundaries

Address mutations revalidate the live principal and application permissions inside the PostgreSQL transaction. Lock order is principals by UUID, target mailbox, address registry/allocation, and dependent grants or outbox records. The route plugin authenticates sessions and mutation CSRF before parsing at most 16 KiB of JSON.

## Provisioning and reserved names

First-login allocation accepts only an ASCII alphanumeric local part with optional interior dots, underscores, and hyphens, with alphanumeric ends and valid dot-atom syntax. Other usernames retain a personal mailbox in `needs_address` and require an approved alternative. Ordinary aliases may use additional dot-atom characters, including `+`, through the approval flow.

The built-in reserved set covers RFC 2142 role names and administrative, billing, bounce, DMARC, HR, and payroll names. `AddressConfig.reservedLocalParts` adds exact local parts to that set, case-insensitively. Ordinary requests cannot claim reserved names; authorized administrators may assign them directly.

Eligible `GET /api/addresses` requests retry idempotent first-mailbox provisioning after a transient login-hook failure. Administrators without `mailbox.use` use administrative routes without provisioning a personal mailbox.

## Monotonic policy snapshots

Each policy contains the complete desired receiving binding. `previousRevision` is the backend's previous desired revision, not a gateway prerequisite: the gateway may apply any strictly newer snapshot. Identical historical operations remain idempotent, but cannot roll the gateway back.

Creating a newer snapshot marks older pending, blocked, or in-flight outbox operations `superseded` and clears their leases. The dispatcher claims only the registry's newest snapshot and rechecks its lease before HTTP submission. An already submitted older request may still finish; a late failure cannot revive its lease, and a late ACK cannot change current sender eligibility or resurrect a superseded operation. Immutable policy history is retained for accepted-mail validation.

Migration `005_policy_recovery.sql` adds the new state and coalesces existing superseded work. Migration `004_addresses.sql` is not modified. A conflict on the newest snapshot remains operator-visible; restoring a backend behind the gateway still requires explicit reconciliation. This is not an automatic disaster-recovery system.

## Legacy cutover boundary

Any address with a `recipient_routes` row, including a disabled row, requires a separate explicit cutover before lifecycle edits. Mutations return `409 legacy_route_cutover_required` and leave legacy V1 receipt untouched. Neither pausing nor changing receive-only silently disables a static route. Newly seeded legacy addresses also remain reserved even if they have no registry allocation yet.

This slice does not implement a cutover CLI. A future operator workflow must publish the dynamic snapshot, account for outstanding V1 deliveries, and change the gateway's routing mode deliberately before removing the legacy reservation.

## Sending remains a resolver only

Sender eligibility requires current admission, membership, an allocation-specific grant, no pause or receive-only restriction, and an exact ACK of the current enabled policy. Returned generation/grant identifiers are not reusable dispatch permits. No outbound transport or send queue is implemented in this module.
