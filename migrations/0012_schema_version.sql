-- The Worker fails closed when it serves a schema it was not built against.
-- Every migration that changes the contract must bump this value.
UPDATE meta SET value = '12' WHERE key = 'schema';
