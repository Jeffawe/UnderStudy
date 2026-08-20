-- runs: add the 'attributed' mode.
--
-- `runs.mode` assumed the Understudy executor drove everything: execute,
-- emit-only, dry-run. But the operating contract explicitly permits reaching a
-- goal another way — "the executor is not sacred" — and a Stripe-hosted
-- checkout or an unimplemented IR action makes that the ONLY way.
--
-- The cost of that escape hatch went unnoticed until now: a hand-driven run
-- wrote no `runs` row at all, so it laid down no drift baseline and left no
-- trace that the goal had ever been achieved. Measured on providernow — a
-- successful paid intake on 2026-08-20, and the newest run row was still
-- 2026-08-13.
--
-- 'attributed' means: this goal really was run, and the result is true, but
-- Understudy did not drive it. Kept as a distinct mode rather than reusing
-- 'execute' precisely so nobody later mistakes it for evidence that the
-- EXECUTOR works — the two claims are different and only one of them is
-- self-verifying.

ALTER TABLE runs DROP CONSTRAINT IF EXISTS check_mode;

ALTER TABLE runs ADD CONSTRAINT check_mode CHECK (mode IN (
  'execute','emit-only','dry-run','attributed'));
