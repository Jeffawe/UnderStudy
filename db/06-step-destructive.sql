-- Migration 06 — mark destructiveness on STEPS, not only on flows.
--
-- THE ROUTING HOLE. Destructiveness was computed per flow. Mark a segment
-- destructive and `recall()`'s +0.50 penalty pushes it down the ranking — so
-- the planner binds a DIFFERENTLY-LABELLED flow that performs the same actions,
-- the plan never registers as destructive, and the safety gate never fires.
-- Observed exactly that while testing the gate: the penalty routed around it.
--
-- THE FIX IS STRUCTURAL, NOT MORE SIGNALS. A segment shares its parent's step
-- rows through `flow_steps` — that is the whole point of the join table. So if
-- destructiveness lives on the STEP, every flow containing that step is
-- destructive automatically, in both directions: parent to segment, segment to
-- parent, and to any mined macro that happens to include it. There is no
-- differently-labelled equivalent to bind, because an equivalent flow is made
-- of the same rows.
--
-- flows.destructive stays, derived from its steps, so the safety gate keeps
-- reading one boolean.
--
-- Apply:  TARGET=local ./scripts/db.sh -f db/06-step-destructive.sql
--         TARGET=cloud ./scripts/db.sh -f db/06-step-destructive.sql
--
-- Safe to re-run.

ALTER TABLE steps ADD COLUMN IF NOT EXISTS destructive BOOL NOT NULL DEFAULT false;

-- Why a step was judged destructive, so the marking can be audited rather than
-- taken on faith. Inference-only and fails open: no signal means not
-- destructive, and no question is ever asked.
ALTER TABLE steps ADD COLUMN IF NOT EXISTS destructive_signal STRING;
