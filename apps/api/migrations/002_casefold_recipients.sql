-- Configured addresses use case-insensitive lookup. Fail on existing collisions;
-- never silently merge mailboxes or recipient routes during migration.
CREATE UNIQUE INDEX mailboxes_address_casefold ON mailboxes (lower(address));
CREATE UNIQUE INDEX recipient_routes_address_casefold ON recipient_routes (lower(address));
