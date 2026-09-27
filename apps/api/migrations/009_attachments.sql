-- Immutable attachment identities are independent of mailbox authorization and storage location.
CREATE TABLE attachment_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  staging_bytes bigint NOT NULL DEFAULT 0 CHECK (staging_bytes >= 0),
  storage_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0)
);
INSERT INTO attachment_capacity(singleton) VALUES (true);

CREATE TABLE attachment_inventories (
  delivery_id uuid PRIMARY KEY REFERENCES deliveries(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','unavailable','drift')),
  extractor_version integer,
  options_sha256 text CHECK (options_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest jsonb CHECK (jsonb_typeof(manifest) = 'array'),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((manifest IS NULL AND extractor_version IS NULL AND options_sha256 IS NULL AND manifest_sha256 IS NULL)
    OR (manifest IS NOT NULL AND extractor_version > 0 AND options_sha256 IS NOT NULL AND manifest_sha256 IS NOT NULL))
);
CREATE TABLE attachment_objects (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  object_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'staging' CHECK (state IN ('staging','queued','ready')),
  preview_kind text NOT NULL CHECK (preview_kind IN ('none','pdf','raster')),
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  stage_released_at timestamptz,
  CHECK ((state = 'ready') = (ready_at IS NOT NULL)),
  CHECK (stage_released_at IS NULL OR state = 'ready')
);
CREATE TABLE message_attachments (
  delivery_id uuid NOT NULL REFERENCES deliveries(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  attachment_id uuid NOT NULL UNIQUE REFERENCES attachment_objects(id),
  filename text NOT NULL,
  mime_type text NOT NULL,
  disposition text,
  content_id text,
  delivery_kind text NOT NULL DEFAULT 'mime' CHECK (delivery_kind = 'mime'),
  PRIMARY KEY (delivery_id,ordinal)
);
CREATE TABLE attachment_extraction_jobs (
  delivery_id uuid PRIMARY KEY REFERENCES deliveries(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inflight','waiting_budget','done','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  extractor_version_attempted integer NOT NULL DEFAULT 0 CHECK (extractor_version_attempted >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error_code text,
  completed_at timestamptz,
  CHECK ((status = 'inflight') = (lease_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX attachment_extraction_jobs_due ON attachment_extraction_jobs(available_at) WHERE status <> 'done';
CREATE TABLE attachment_upload_jobs (
  id uuid PRIMARY KEY,
  attachment_id uuid NOT NULL UNIQUE REFERENCES attachment_objects(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inflight','done','blocked')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error_code text,
  completed_at timestamptz,
  CHECK ((status = 'inflight') = (lease_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX attachment_upload_jobs_due ON attachment_upload_jobs(available_at) WHERE status IN ('pending','inflight');

CREATE FUNCTION preserve_attachment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'attachment_objects' THEN
    IF (NEW.id,NEW.sha256,NEW.size_bytes,NEW.object_key,NEW.preview_kind,NEW.media_type,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.sha256,OLD.size_bytes,OLD.object_key,OLD.preview_kind,OLD.media_type,OLD.created_at)
       OR (OLD.state = 'ready' AND NEW.state <> 'ready') THEN
      RAISE EXCEPTION 'attachment_identity_immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'attachment_inventories' THEN
    IF OLD.manifest IS NOT NULL AND (NEW.delivery_id,NEW.extractor_version,NEW.options_sha256,NEW.manifest_sha256,NEW.manifest)
       IS DISTINCT FROM (OLD.delivery_id,OLD.extractor_version,OLD.options_sha256,OLD.manifest_sha256,OLD.manifest) THEN
      RAISE EXCEPTION 'attachment_manifest_immutable';
    END IF;
  ELSE
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'attachment_association_immutable'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attachment_objects_immutable BEFORE UPDATE ON attachment_objects FOR EACH ROW EXECUTE FUNCTION preserve_attachment_identity();
CREATE TRIGGER attachment_manifest_immutable BEFORE UPDATE ON attachment_inventories FOR EACH ROW EXECUTE FUNCTION preserve_attachment_identity();
CREATE TRIGGER message_attachments_immutable BEFORE UPDATE ON message_attachments FOR EACH ROW EXECUTE FUNCTION preserve_attachment_identity();
