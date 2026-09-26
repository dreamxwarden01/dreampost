CREATE INDEX deliveries_recipient_inspection ON deliveries(lower(json_extract(metadata_json, '$.envelopeTo')), delivery_id);
