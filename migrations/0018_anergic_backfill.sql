-- Existing scan rows predate the anergic marker.  The report-only set is a
-- published ledger, so the historical rows can be classified without guessing.
UPDATE scan_rule_events
   SET anergic = 1, weight = 0
 WHERE rule_id IN ('A011','A012','A013','A014','A015','A016','C035','G016','H109','S011');

UPDATE meta SET value = '18' WHERE key = 'schema';
