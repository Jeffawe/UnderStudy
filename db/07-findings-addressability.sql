-- Findings: add the 'addressability' kind.
--
-- The closed vocabulary had no slot for "this element cannot be addressed",
-- so a real, automation-blocking defect had to be filed as 'other'. That is
-- the wrong bucket for it: an unnamed control is not a miscellaneous
-- observation, it is the specific class of defect that makes a seam
-- permanently unresolvable and forces a whole flow to bind as one recording
-- instead of composing from segments. It deserves to be findable as itself.
--
-- Safe on a populated table: widening an IN list can only accept rows the old
-- constraint already accepted.

ALTER TABLE findings DROP CONSTRAINT IF EXISTS check_kind;

ALTER TABLE findings ADD CONSTRAINT check_kind CHECK (kind IN (
  'console_error','network_error','data_mismatch','persistence',
  'nondeterminism','flow_drift','perf','addressability','other'));
