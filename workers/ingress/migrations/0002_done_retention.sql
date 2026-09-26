CREATE INDEX deliveries_done_retention ON deliveries(updated_at, delivery_id) WHERE state = 'done';
