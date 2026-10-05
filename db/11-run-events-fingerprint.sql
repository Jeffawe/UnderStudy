-- run_events: carry the step's fingerprint on the event itself.
--
-- `times_helped` asks whether a step of this KIND (action|role|name|route) has
-- ever failed, and it answered by joining run_events -> steps for the
-- fingerprint. But run_events.step_id is ON DELETE SET NULL (db/03), and every
-- re-ingest replaces the step rows — so each re-ingest silently erased the
-- failure history that question depends on. Measured on a real corpus: 392 of
-- 660 events had already lost their step_id, and with it any record of what
-- kind of step they were.
--
-- The fingerprint is a property of what HAPPENED, so it belongs on the
-- historical record, frozen at write time. The step_id stays as a convenience
-- pointer that is allowed to go stale.
--
-- Events that already lost their step_id cannot be recovered and stay NULL.

ALTER TABLE run_events ADD COLUMN IF NOT EXISTS fingerprint STRING;

UPDATE run_events e SET fingerprint = s.fingerprint
FROM steps s
WHERE s.step_id = e.step_id AND e.fingerprint IS NULL;

CREATE INDEX IF NOT EXISTS run_events_fingerprint_idx ON run_events (fingerprint, outcome);
