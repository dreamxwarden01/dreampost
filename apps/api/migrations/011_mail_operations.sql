ALTER TABLE auth_role_permissions DROP CONSTRAINT auth_role_permissions_permission_check;
ALTER TABLE auth_role_permissions ADD CONSTRAINT auth_role_permissions_permission_check
  CHECK (permission IN ('mailbox.use','addresses.manage','roles.manage','mail.manage','mail.send'));
ALTER TABLE auth_user_permission_overrides DROP CONSTRAINT auth_user_permission_overrides_permission_check;
ALTER TABLE auth_user_permission_overrides ADD CONSTRAINT auth_user_permission_overrides_permission_check
  CHECK (permission IN ('mailbox.use','addresses.manage','roles.manage','mail.manage','mail.send'));
INSERT INTO auth_role_permissions(role_id,permission) VALUES
  (0,'mail.manage'),(0,'mail.send'),(1,'mail.manage'),(1,'mail.send') ON CONFLICT DO NOTHING;
UPDATE mailbox_memberships mm SET permissions = array_append(mm.permissions,'manage_messages')
 FROM mailboxes m WHERE m.id=mm.mailbox_id AND m.mailbox_type='personal'
 AND m.owner_principal_id=mm.principal_id AND m.enabled AND mm.revoked_at IS NULL AND NOT ('manage_messages'=ANY(mm.permissions));

ALTER TABLE deliveries ADD COLUMN direction text NOT NULL DEFAULT 'inbound' CHECK(direction IN ('inbound','outbound'));
ALTER TABLE deliveries ADD CONSTRAINT deliveries_mailbox_identity UNIQUE(mailbox_id,id);
CREATE TABLE mail_threads (
  id uuid PRIMARY KEY, mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(mailbox_id,id)
);
CREATE TABLE mail_message_state (
  message_id uuid PRIMARY KEY, mailbox_id uuid NOT NULL, thread_id uuid,
  folder text NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox','archive','trash','spam')),
  filing_version bigint NOT NULL DEFAULT 1 CHECK(filing_version>0), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(mailbox_id,message_id) REFERENCES deliveries(mailbox_id,id),
  FOREIGN KEY(mailbox_id,thread_id) REFERENCES mail_threads(mailbox_id,id), UNIQUE(mailbox_id,message_id)
);
CREATE INDEX mail_message_state_thread ON mail_message_state(mailbox_id,thread_id);
CREATE INDEX mail_message_state_folder ON mail_message_state(mailbox_id,folder,message_id);
INSERT INTO mail_message_state(message_id,mailbox_id) SELECT id,mailbox_id FROM deliveries;
CREATE TABLE principal_message_flags (
  mailbox_id uuid NOT NULL, message_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES principals(id),
  is_read boolean NOT NULL, is_starred boolean NOT NULL DEFAULT false,
  flags_version bigint NOT NULL DEFAULT 1 CHECK(flags_version>0), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mailbox_id,message_id,principal_id),
  FOREIGN KEY(mailbox_id,message_id) REFERENCES deliveries(mailbox_id,id)
);
CREATE INDEX principal_message_flags_actor ON principal_message_flags(mailbox_id,principal_id,is_read,is_starred);
CREATE TABLE mail_thread_keys (
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id), token text NOT NULL CHECK(octet_length(token)<=998),
  thread_id uuid NOT NULL, claim_message_id uuid, ambiguous boolean NOT NULL DEFAULT false,
  PRIMARY KEY(mailbox_id,token), FOREIGN KEY(mailbox_id,thread_id) REFERENCES mail_threads(mailbox_id,id),
  FOREIGN KEY(mailbox_id,claim_message_id) REFERENCES deliveries(mailbox_id,id)
);
CREATE TABLE mail_thread_headers (
  message_id uuid PRIMARY KEY, mailbox_id uuid NOT NULL, parser_version integer NOT NULL CHECK(parser_version>0),
  message_id_header text, reference_ids jsonb NOT NULL DEFAULT '[]', in_reply_to jsonb NOT NULL DEFAULT '[]',
  warnings jsonb NOT NULL DEFAULT '[]', indexed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(mailbox_id,message_id) REFERENCES deliveries(mailbox_id,id)
);
CREATE TABLE mailbox_labels (
  id uuid PRIMARY KEY, mailbox_id uuid NOT NULL REFERENCES mailboxes(id), name text NOT NULL,
  color text, version bigint NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(length(name) BETWEEN 1 AND 100), CHECK(color IS NULL OR color ~ '^#[0-9a-f]{6}$'), UNIQUE(mailbox_id,id)
);
CREATE UNIQUE INDEX mailbox_labels_name ON mailbox_labels(mailbox_id,lower(name));
CREATE TABLE mail_message_labels (
  mailbox_id uuid NOT NULL, message_id uuid NOT NULL, label_id uuid NOT NULL,
  PRIMARY KEY(mailbox_id,message_id,label_id),
  FOREIGN KEY(mailbox_id,message_id) REFERENCES deliveries(mailbox_id,id),
  FOREIGN KEY(mailbox_id,label_id) REFERENCES mailbox_labels(mailbox_id,id) ON DELETE CASCADE
);
CREATE INDEX mail_message_labels_label ON mail_message_labels(mailbox_id,label_id,message_id);
CREATE TABLE mail_operations (
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id), actor_id uuid NOT NULL REFERENCES principals(id), operation_id uuid NOT NULL,
  kind text NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'), result jsonb NOT NULL,
  inverse jsonb, undo_until timestamptz, undone_result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mailbox_id,actor_id,operation_id)
);
CREATE INDEX mail_operations_expiry ON mail_operations(created_at);
ALTER TABLE mailbox_changes ALTER COLUMN delivery_id DROP NOT NULL;
ALTER TABLE mailbox_changes ADD COLUMN actor_principal_id uuid REFERENCES principals(id);
ALTER TABLE mailbox_changes ADD COLUMN data jsonb NOT NULL DEFAULT '{}';
