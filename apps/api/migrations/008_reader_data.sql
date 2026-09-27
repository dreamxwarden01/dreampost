-- A manual backfill schedules each parser version once; normal pending-job retries stay independent.
ALTER TABLE durable_jobs ADD COLUMN parser_version_attempted integer NOT NULL DEFAULT 0
  CHECK (parser_version_attempted >= 0);

-- Derived reader data is rebuildable; original delivery ownership and raw bytes remain unchanged.
CREATE TABLE message_reader_data (
  delivery_id uuid PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
  parser_version integer NOT NULL CHECK (parser_version > 0),
  parsed_at timestamptz NOT NULL DEFAULT now(),
  headers jsonb NOT NULL CHECK (jsonb_typeof(headers) = 'object'),
  html_source text,
  inline_candidates jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(inline_candidates) = 'array'),
  warnings jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array')
);
CREATE TABLE principal_preferences (
  principal_id uuid PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  auto_load_external_images boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
