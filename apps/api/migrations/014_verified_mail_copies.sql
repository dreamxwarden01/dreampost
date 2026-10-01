-- Fingerprints are full-content evidence, never a replacement for immutable raw MIME.
CREATE TABLE mail_content_fingerprints (
  delivery_id uuid PRIMARY KEY, mailbox_id uuid NOT NULL, version integer NOT NULL CHECK(version=1),
  sha256 text CHECK(sha256 ~ '^[0-9a-f]{64}$'), raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[0-9a-f]{64}$'),
  raw_size integer NOT NULL CHECK(raw_size>0), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(mailbox_id,delivery_id) REFERENCES deliveries(mailbox_id,id)
);
CREATE TABLE mail_verified_copies (
  inbound_message_id uuid PRIMARY KEY, mailbox_id uuid NOT NULL, sent_message_id uuid NOT NULL,
  fingerprint_version integer NOT NULL CHECK(fingerprint_version=1), fingerprint_sha256 text NOT NULL CHECK(fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  wire_message_id text NOT NULL CHECK(octet_length(wire_message_id)<=998), envelope_recipient text NOT NULL,
  allocation_id uuid NOT NULL REFERENCES address_allocations(id), route_revision bigint NOT NULL CHECK(route_revision>0),
  policy_digest text NOT NULL CHECK(policy_digest ~ '^[0-9a-f]{64}$'),
  inbound_raw_sha256 text NOT NULL CHECK(inbound_raw_sha256 ~ '^[0-9a-f]{64}$'), inbound_raw_size integer NOT NULL CHECK(inbound_raw_size>0),
  sent_raw_sha256 text NOT NULL CHECK(sent_raw_sha256 ~ '^[0-9a-f]{64}$'), sent_raw_size integer NOT NULL CHECK(sent_raw_size>0),
  verified_at timestamptz NOT NULL DEFAULT now(), CHECK(inbound_message_id<>sent_message_id),
  FOREIGN KEY(mailbox_id,inbound_message_id) REFERENCES deliveries(mailbox_id,id),
  FOREIGN KEY(mailbox_id,sent_message_id) REFERENCES deliveries(mailbox_id,id)
);
CREATE INDEX verified_copies_sent ON mail_verified_copies(mailbox_id,sent_message_id,inbound_message_id);
-- Preserve every observed claim across reparsing and deleted-message history.
CREATE TABLE mail_thread_identity_claims (
  mailbox_id uuid NOT NULL, token text NOT NULL CHECK(octet_length(token)<=998), message_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(mailbox_id,token,message_id),
  FOREIGN KEY(mailbox_id,message_id) REFERENCES deliveries(mailbox_id,id)
);
INSERT INTO mail_thread_identity_claims(mailbox_id,token,message_id)
  SELECT mailbox_id,message_id_header,message_id FROM mail_thread_headers WHERE message_id_header IS NOT NULL
  ON CONFLICT DO NOTHING;
INSERT INTO mail_thread_identity_claims(mailbox_id,token,message_id)
  SELECT mailbox_id,token,claim_message_id FROM mail_thread_keys WHERE claim_message_id IS NOT NULL
  ON CONFLICT DO NOTHING;
-- Earlier versions kept only the first claim. Old ambiguity is not proof that its
-- entire historical competing set is known, so ordinary reconciliation retains it.
ALTER TABLE mail_thread_keys ADD COLUMN ambiguity_unproven boolean NOT NULL DEFAULT false;
UPDATE mail_thread_keys SET ambiguity_unproven=true WHERE ambiguous;

CREATE INDEX thread_headers_own_identity ON mail_thread_headers(mailbox_id,message_id_header) WHERE message_id_header IS NOT NULL;
CREATE INDEX outbound_rfc_identity_lookup ON outbound_submissions(mailbox_id,rfc_message_id) WHERE rfc_message_id IS NOT NULL AND state IN ('accepted','partial');
CREATE INDEX thread_keys_membership ON mail_thread_keys(mailbox_id,thread_id);


-- Capture identity evidence independently of application writer version. The old
-- and new claims survive reparsing, reassignment and header/key row deletion.
CREATE FUNCTION capture_mail_header_identity_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.message_id_header IS NOT NULL THEN
    INSERT INTO mail_thread_identity_claims(mailbox_id,token,message_id)
      VALUES(OLD.mailbox_id,OLD.message_id_header,OLD.message_id) ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.message_id_header IS NOT NULL THEN
    INSERT INTO mail_thread_identity_claims(mailbox_id,token,message_id)
      VALUES(NEW.mailbox_id,NEW.message_id_header,NEW.message_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_header_identity_history AFTER INSERT OR UPDATE OF mailbox_id,message_id,message_id_header
  ON mail_thread_headers FOR EACH ROW EXECUTE FUNCTION capture_mail_header_identity_claim();

CREATE FUNCTION capture_mail_key_identity_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.claim_message_id IS NOT NULL THEN
    INSERT INTO mail_thread_identity_claims(mailbox_id,token,message_id)
      VALUES(OLD.mailbox_id,OLD.token,OLD.claim_message_id) ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.claim_message_id IS NOT NULL THEN
    INSERT INTO mail_thread_identity_claims(mailbox_id,token,message_id)
      VALUES(NEW.mailbox_id,NEW.token,NEW.claim_message_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_key_identity_history AFTER INSERT OR UPDATE OF mailbox_id,token,claim_message_id
  ON mail_thread_keys FOR EACH ROW EXECUTE FUNCTION capture_mail_key_identity_claim();

CREATE FUNCTION preserve_mail_identity_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mail_identity_claim_append_only';
END;
$$;
CREATE TRIGGER mail_identity_claim_append_only BEFORE UPDATE OR DELETE ON mail_thread_identity_claims
  FOR EACH ROW EXECUTE FUNCTION preserve_mail_identity_claim();
