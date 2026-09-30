-- A provider receipt is not necessarily an RFC Message-ID. Existing receipts
-- remain unclassified; only new explicit transport evidence or a guarded,
-- independently verified operator repair may populate this field.
ALTER TABLE outbound_submissions ADD COLUMN rfc_message_id text
  CHECK (rfc_message_id IS NULL OR (octet_length(rfc_message_id) BETWEEN 5 AND 998
    AND rfc_message_id ~ '^<[!-~]+@[!-~]+>$'));
ALTER TABLE outbound_submissions ADD CONSTRAINT outbound_rfc_identity_requires_acceptance
  CHECK (rfc_message_id IS NULL OR state IN ('accepted','partial'));

CREATE FUNCTION preserve_outbound_rfc_message_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.rfc_message_id IS NOT NULL AND NEW.rfc_message_id IS DISTINCT FROM OLD.rfc_message_id THEN
    RAISE EXCEPTION 'outbound_rfc_message_id_immutable';
  END IF;
  IF NEW.rfc_message_id IS DISTINCT FROM OLD.rfc_message_id AND NEW.state NOT IN ('accepted','partial') THEN
    RAISE EXCEPTION 'outbound_rfc_message_id_requires_acceptance';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outbound_rfc_message_id_immutable BEFORE UPDATE ON outbound_submissions
  FOR EACH ROW EXECUTE FUNCTION preserve_outbound_rfc_message_id();
