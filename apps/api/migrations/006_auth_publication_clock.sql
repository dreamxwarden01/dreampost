-- Reserve a publication timestamp before network submission, including lost-ACK attempts.
CREATE TABLE auth_catalog_publications (
  issuer text NOT NULL,
  client_id text NOT NULL,
  last_issued_at bigint NOT NULL CHECK (last_issued_at >= 0),
  PRIMARY KEY (issuer, client_id)
);
