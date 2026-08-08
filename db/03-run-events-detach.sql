-- Migration 03 — let run history survive a re-ingest.
--
-- THE CONFLICT: re-ingesting a recording replaces its `steps` rows, but
-- `run_events.step_id` and `.selector_id` referenced them with the default
-- RESTRICT, so the teardown failed:
--
--   delete on table "steps" violates foreign key constraint
--   "run_events_step_id_fkey" on table "run_events"
--
-- Ingest became un-repeatable the moment anything recorded a run — and since
-- ingest now records the run that verified it, that was immediately.
--
-- THE RESOLUTION: a run event is a HISTORICAL RECORD. It carries the outcome,
-- the error, the observed sig, the timings, the console and the network
-- traffic — all of which stay true regardless of whether the step row it
-- pointed at still exists. The link is a convenience, not the substance.
-- Losing the link on re-ingest is acceptable; losing the run is not, because
-- run history is the flow-drift baseline and the findings trail.
--
-- The alternative was to stop garbage-collecting replaced steps, which would
-- accumulate dead rows forever to preserve a pointer nothing depends on.
--
-- Apply:  TARGET=local ./scripts/db.sh -f db/03-run-events-detach.sql
--         TARGET=cloud ./scripts/db.sh -f db/03-run-events-detach.sql
--
-- Safe to re-run.

ALTER TABLE run_events DROP CONSTRAINT IF EXISTS run_events_step_id_fkey;
ALTER TABLE run_events DROP CONSTRAINT IF EXISTS run_events_selector_id_fkey;

ALTER TABLE run_events
  ADD CONSTRAINT run_events_step_id_fkey
  FOREIGN KEY (step_id) REFERENCES steps(step_id) ON DELETE SET NULL;

ALTER TABLE run_events
  ADD CONSTRAINT run_events_selector_id_fkey
  FOREIGN KEY (selector_id) REFERENCES selectors(selector_id) ON DELETE SET NULL;
