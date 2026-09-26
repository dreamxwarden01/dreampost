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

The local operator workflow prepares and stages the same legacy allocation/mailbox, verifies immutable signed static-stage evidence, then records `dynamic_compatibility` only after fresh authenticated inspection confirms the configured gateway, deployment version, and exact initial staged snapshot. It retains the V1 route and lifecycle guard. An empty backlog is not a writer fence and does not complete cutover. Retiring the V1 reservation remains a separate future workflow.

## Sending remains a resolver only

Sender eligibility requires current admission, membership, an allocation-specific grant, no pause or receive-only restriction, and an exact ACK of the current enabled policy. Returned generation/grant identifiers are not reusable dispatch permits. No outbound transport or send queue is implemented in this module.

## Local operator workflows

`AddressOperatorService` is a privileged local maintenance capability, not a user-session API. Its mandatory exact-address allowlist and the gateway client's separately scoped credentials limit which recipient it can affect. `operatorLabel` is audit attribution, not a login or credential; audit rows have no impersonated principal. Do not expose the service through ordinary HTTP routes.

`prepareLegacy` transactionally records an initial enabled snapshot only for the existing enabled legacy tuple and current legacy allocation without holds. It does not assign the mailbox, issue send grants, or alter V1 receipt. `stageLegacy` targets that exact operation and accepts only a validated `202/prepared` acknowledgment. These operations use `dispatch_kind=legacy_prepare`, which the ordinary dispatcher excludes.

`verifyStaged` captures signed static-mode evidence for the original mailbox and initial prepared operation. Its policy address allowlist must exactly equal the local operator allowlist. Static and dynamic deployments may have different explicitly approved version IDs, but the gateway identity and prepared binding remain the same. Stage evidence is immutable once recorded.

Dynamic confirmation obtains a new inspection through the authenticated gateway client instead of trusting a caller-supplied object. It requires that stage proof, the exact initial operation, expected gateway/version, exact policy scope, freshness, and the original mailbox/allocation. Reconciliation planning and application are rejected while preparation is unconfirmed. The first dynamic evidence is immutable; an idempotent repeat returns the original record, and incompatible confirmation arguments are rejected. This records compatibility with V2 admission, not the absence of older V1 writers.

Policy reconciliation first creates an immutable, expiring plan with a canonical digest, the full verified remote inspection, local desired-state preconditions, and the exact remote revision/digest. Explicit application reserves a new local revision and durable plan intent before network I/O. It does not write speculative admission history. The gateway atomically compares the remote precondition before applying the higher snapshot. Only a verified ACK or exact fresh readback permits inserting immutable applied history and a terminal outbox record.

Failed CAS leaves a reserved revision gap and a failed plan, without poisoning a potentially legitimate remote policy at that revision. A fresh plan can advance again. Lost-ACK recovery does not republish a known-applied policy, and may preserve its historical evidence after a newer local pause; it cannot reopen current sending eligibility. Reconciliation refuses unknown remote mailbox/allocation ownership. Writing a reconciliation repairs future admission state only. `recoverReconciliation` is a separate read-only evidence operation that can run after plan expiry. It retrieves a signed historical operation record, so a newer remote policy does not hide a lost ACK. The full immutable plan policy and digest must match, and the historical local allocation/mailbox must already exist.

Recovery does not call stage or reconcile, change the registry, clear holds, issue grants, or adopt another owner's allocation. Newly recovered history receives a `superseded` outbox record even if its revision equals the registry, so historical recovery cannot activate sending. Already applied records remain applied. Missing records, mismatches, or unknown local bindings are refused; mail remains retryable with raw data retained until trustworthy evidence is available. Recovered plans cannot be reused for cloud writes; a fresh explicit plan is required. Cross-owner reconciliation remains deliberately deferred.

Migration `007_operator_workflows.sql` adds operator records, the prepared outbox state, and dispatch kinds. It does not modify existing routes or apply a cloud cutover. Operator plans and original preparation bindings are immutable. Successful application repeated with the same digest reports the recorded result; it is not a fresh assertion of gateway state.
