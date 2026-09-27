CREATE TABLE outbound_drafts (
  id uuid PRIMARY KEY, mailbox_id uuid NOT NULL REFERENCES mailboxes(id), author_principal_id uuid NOT NULL REFERENCES principals(id),
  version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  state text NOT NULL DEFAULT 'editing' CHECK (state IN ('editing','queued','discarded')),
  mode text NOT NULL CHECK (mode IN ('new','reply','reply_all','reply_person','forward')),
  source_message_id uuid REFERENCES deliveries(id), from_allocation_id uuid REFERENCES address_allocations(id),
  to_recipients jsonb NOT NULL DEFAULT '[]', cc_recipients jsonb NOT NULL DEFAULT '[]', bcc_recipients jsonb NOT NULL DEFAULT '[]',
  subject text NOT NULL DEFAULT '', body_text text NOT NULL DEFAULT '', quote jsonb, warnings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(to_recipients)='array' AND jsonb_typeof(cc_recipients)='array' AND jsonb_typeof(bcc_recipients)='array')
);
CREATE INDEX outbound_drafts_author ON outbound_drafts(author_principal_id,mailbox_id,updated_at);
CREATE TABLE outbound_draft_attachments (
  id uuid PRIMARY KEY, draft_id uuid NOT NULL REFERENCES outbound_drafts(id), filename text NOT NULL, mime_type text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  bytes bytea, released_at timestamptz, source_message_id uuid REFERENCES deliveries(id), source_attachment_id uuid REFERENCES attachment_objects(id),
  source_content_version text, source_sha256 text CHECK(source_sha256 ~ '^[0-9a-f]{64}$'), created_at timestamptz NOT NULL DEFAULT now(), CHECK (bytes IS NULL OR octet_length(bytes)=size_bytes), CHECK ((bytes IS NULL)=(released_at IS NOT NULL))
);
CREATE INDEX outbound_draft_attachments_draft ON outbound_draft_attachments(draft_id,created_at,id);
CREATE TABLE outbound_submissions (
  id uuid PRIMARY KEY, draft_id uuid NOT NULL REFERENCES outbound_drafts(id), draft_version bigint NOT NULL,
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id), author_principal_id uuid NOT NULL REFERENCES principals(id),
  version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','dispatching','accepted','partial','failed','blocked','unknown','cancelled')),
  snapshot jsonb NOT NULL, raw_sha256 text CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'), raw_size integer,
  provider_message_id text, error_code text, available_at timestamptz NOT NULL DEFAULT now(), queue_deadline timestamptz NOT NULL,
  lease_id uuid, lease_until timestamptz, current_attempt_id uuid, sent_message_id uuid REFERENCES deliveries(id),
  stage_released_at timestamptz, stage_release_after timestamptz NOT NULL DEFAULT now(), stage_release_error text,
  sent_copy_state text NOT NULL DEFAULT 'none' CHECK (sent_copy_state IN ('none','pending','done')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(draft_id,draft_version), CHECK ((raw_sha256 IS NULL)=(raw_size IS NULL))
);
CREATE INDEX outbound_submissions_due ON outbound_submissions(available_at) WHERE state='queued';
CREATE TABLE outbound_recipients (
  submission_id uuid NOT NULL REFERENCES outbound_submissions(id), address text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','failed','unknown')), code text,
  PRIMARY KEY(submission_id,address)
);
CREATE TABLE outbound_attempts (
  id uuid PRIMARY KEY, submission_id uuid NOT NULL REFERENCES outbound_submissions(id),
  state text NOT NULL CHECK (state IN ('dispatching','completed','unknown','not_started')),
  start_deadline timestamptz NOT NULL, expires_at timestamptz NOT NULL, request_sha256 text NOT NULL,
  result jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
ALTER TABLE outbound_submissions ADD CONSTRAINT outbound_current_attempt_fk FOREIGN KEY(current_attempt_id) REFERENCES outbound_attempts(id);
CREATE TABLE outbound_mutations (
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id), author_principal_id uuid NOT NULL REFERENCES principals(id), mutation_key uuid NOT NULL,
  action text NOT NULL DEFAULT 'legacy', target_id uuid,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'), response jsonb NOT NULL CHECK (jsonb_typeof(response)='object' AND octet_length(response::text)<=512),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days', PRIMARY KEY(mailbox_id,author_principal_id,mutation_key)
);
CREATE INDEX outbound_mutations_patch_target ON outbound_mutations(author_principal_id,mailbox_id,target_id) WHERE action='patch';
CREATE INDEX outbound_mutations_global_expiry ON outbound_mutations(expires_at);
CREATE INDEX outbound_mutations_expiry ON outbound_mutations(author_principal_id,expires_at);
CREATE FUNCTION preserve_outbound_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.draft_id,NEW.draft_version,NEW.mailbox_id,NEW.author_principal_id,NEW.snapshot,NEW.queue_deadline)
     IS DISTINCT FROM (OLD.id,OLD.draft_id,OLD.draft_version,OLD.mailbox_id,OLD.author_principal_id,OLD.snapshot,OLD.queue_deadline)
     OR (OLD.raw_sha256 IS NOT NULL AND (NEW.raw_sha256,NEW.raw_size) IS DISTINCT FROM (OLD.raw_sha256,OLD.raw_size)) THEN
    RAISE EXCEPTION 'outbound_snapshot_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outbound_snapshot_immutable BEFORE UPDATE ON outbound_submissions FOR EACH ROW EXECUTE FUNCTION preserve_outbound_snapshot();
