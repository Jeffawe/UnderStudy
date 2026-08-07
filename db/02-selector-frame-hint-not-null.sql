-- Migration 02 — make selector dedupe actually dedupe.
--
-- THE BUG: `UNIQUE (app_id, role, name, frame_hint)` does not constrain rows
-- whose frame_hint is NULL, because in SQL NULL is never equal to NULL. Almost
-- every element is in the main frame and therefore had frame_hint NULL, so the
-- constraint was inert for virtually the whole table and `ON CONFLICT ... DO
-- UPDATE` never fired. Observed: "Add to cart" x3, "Login" x2, "Username" x2.
--
-- WHY IT MATTERS: one row per element is the property the entire health model
-- rests on. CLAUDE.md: "one health score per element (a rename degrades every
-- flow at once, and you see one cause not twelve); heal once and all flows are
-- fixed; quarantine at >=3 failures / 0 successes drops the chunk from
-- recall()." Split across duplicates, a failing element never reaches the
-- quarantine threshold and never heals consistently.
--
-- FIX: frame_hint becomes NOT NULL DEFAULT '' — empty string means "main
-- frame". Every row then has a comparable value and the unique index bites.
--
-- ORDER MATTERS: dedupe BEFORE normalizing. Setting frame_hint = '' first makes
-- the existing duplicates collide and the statement fails on its own cleanup.
-- GROUP BY treats NULLs as one group even though the unique index does not,
-- which is exactly what lets step 1 run while the NULLs are still there.
--
-- Apply:  TARGET=local ./scripts/db.sh -f db/02-selector-frame-hint-not-null.sql
--         TARGET=cloud ./scripts/db.sh -f db/02-selector-frame-hint-not-null.sql
--
-- Safe to re-run.

-- 1. Repoint every reference at the surviving row. Lowest selector_id per group
--    wins — arbitrary, but deterministic so a re-run is a no-op.
WITH keepers AS (
  SELECT app_id, role, name, frame_hint, min(selector_id::STRING) AS keep_id
  FROM selectors
  GROUP BY app_id, role, name, frame_hint
),
dupes AS (
  SELECT s.selector_id AS drop_id, k.keep_id::UUID AS keep_id
  FROM selectors s
  JOIN keepers k
    ON s.app_id = k.app_id
   AND s.role IS NOT DISTINCT FROM k.role
   AND s.name IS NOT DISTINCT FROM k.name
   AND s.frame_hint IS NOT DISTINCT FROM k.frame_hint
  WHERE s.selector_id::STRING <> k.keep_id
)
UPDATE steps SET selector_id = d.keep_id
FROM dupes d WHERE steps.selector_id = d.drop_id;

WITH keepers AS (
  SELECT app_id, role, name, frame_hint, min(selector_id::STRING) AS keep_id
  FROM selectors
  GROUP BY app_id, role, name, frame_hint
),
dupes AS (
  SELECT s.selector_id AS drop_id, k.keep_id::UUID AS keep_id
  FROM selectors s
  JOIN keepers k
    ON s.app_id = k.app_id
   AND s.role IS NOT DISTINCT FROM k.role
   AND s.name IS NOT DISTINCT FROM k.name
   AND s.frame_hint IS NOT DISTINCT FROM k.frame_hint
  WHERE s.selector_id::STRING <> k.keep_id
)
UPDATE page_edges SET via_selector = d.keep_id
FROM dupes d WHERE page_edges.via_selector = d.drop_id;

-- 2. Drop the duplicates, keeping the lowest id per group.
DELETE FROM selectors
WHERE selector_id::STRING NOT IN (
  SELECT min(selector_id::STRING)
  FROM selectors
  GROUP BY app_id, role, name, frame_hint
);

-- 3. NOW normalize — safe, because nothing collides any more.
UPDATE selectors SET frame_hint = '' WHERE frame_hint IS NULL;

-- 4. Make the constraint enforceable from here on.
ALTER TABLE selectors ALTER COLUMN frame_hint SET DEFAULT '';
ALTER TABLE selectors ALTER COLUMN frame_hint SET NOT NULL;
