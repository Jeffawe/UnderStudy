-- runs: add the 'abandoned' status.
--
-- A run opens as 'running' before it starts (openRun) and is closed by
-- recordRun. A run_plan that parks on a question nobody ever answers — the
-- conversation moved on, the session ended — was never closed by anything.
-- Measured on a real corpus: 12 runs sitting in 'running' for up to six weeks,
-- and their questions in 'delivered' forever.
--
-- 'failed' would be the wrong word: nothing was tried and nothing broke, and
-- writing it would put phantom failures into the pass/fail history. So the
-- reaper (src/core/run.ts reapAbandoned) uses a status of its own, and expires
-- the questions those runs were waiting on.

ALTER TABLE runs DROP CONSTRAINT IF EXISTS check_status;

ALTER TABLE runs ADD CONSTRAINT check_status CHECK (status IN (
  'running','passed','failed','blocked','needs_context','abandoned'));
