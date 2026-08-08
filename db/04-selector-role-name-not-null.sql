-- Migration 04 — finish what migration 02 started.
--
-- Migration 02 made `frame_hint` NOT NULL because a NULL component makes
-- UNIQUE(app_id, role, name, frame_hint) inert — SQL never treats NULL as
-- equal to NULL. That fixed ONE of the four columns. `role` and `name` were
-- left nullable, so the identical bug survived in a narrower case: any element
-- with no accessible name.
--
-- It bit immediately. saucedemo's product-sort dropdown genuinely has no
-- accessible name (Playwright agrees), so every ingest inserted ANOTHER
-- `combobox / NULL` row — four of them — because ON CONFLICT could never fire.
-- One element, four health scores, none of which will ever reach the
-- quarantine threshold.
--
-- FIX: '' means "no role" / "no name", which is a fact about the element, not
-- an absence of information. NULL was never the right encoding here.
--
-- LESSON: when a UNIQUE constraint spans several columns, EVERY one of them
-- must be NOT NULL or the constraint is decorative.
--
-- Apply:  TARGET=local ./scripts/db.sh -f db/04-selector-role-name-not-null.sql
--         TARGET=cloud ./scripts/db.sh -f db/04-selector-role-name-not-null.sql
--
-- Safe to re-run. Dedupe BEFORE normalizing, or setting '' creates the very
-- collision it is removing (the mistake made in 02's first draft).

-- 1. Repoint references at the surviving row, lowest id per group.
WITH keepers AS (
  SELECT app_id, role, name, frame_hint, min(selector_id::STRING) AS keep_id
  FROM selectors GROUP BY app_id, role, name, frame_hint
),
dupes AS (
  SELECT s.selector_id AS drop_id, k.keep_id::UUID AS keep_id
  FROM selectors s JOIN keepers k
    ON s.app_id = k.app_id
   AND s.role IS NOT DISTINCT FROM k.role
   AND s.name IS NOT DISTINCT FROM k.name
   AND s.frame_hint IS NOT DISTINCT FROM k.frame_hint
  WHERE s.selector_id::STRING <> k.keep_id
)
UPDATE steps SET selector_id = d.keep_id FROM dupes d WHERE steps.selector_id = d.drop_id;

WITH keepers AS (
  SELECT app_id, role, name, frame_hint, min(selector_id::STRING) AS keep_id
  FROM selectors GROUP BY app_id, role, name, frame_hint
),
dupes AS (
  SELECT s.selector_id AS drop_id, k.keep_id::UUID AS keep_id
  FROM selectors s JOIN keepers k
    ON s.app_id = k.app_id
   AND s.role IS NOT DISTINCT FROM k.role
   AND s.name IS NOT DISTINCT FROM k.name
   AND s.frame_hint IS NOT DISTINCT FROM k.frame_hint
  WHERE s.selector_id::STRING <> k.keep_id
)
UPDATE page_edges SET via_selector = d.keep_id FROM dupes d WHERE page_edges.via_selector = d.drop_id;

WITH keepers AS (
  SELECT app_id, role, name, frame_hint, min(selector_id::STRING) AS keep_id
  FROM selectors GROUP BY app_id, role, name, frame_hint
),
dupes AS (
  SELECT s.selector_id AS drop_id, k.keep_id::UUID AS keep_id
  FROM selectors s JOIN keepers k
    ON s.app_id = k.app_id
   AND s.role IS NOT DISTINCT FROM k.role
   AND s.name IS NOT DISTINCT FROM k.name
   AND s.frame_hint IS NOT DISTINCT FROM k.frame_hint
  WHERE s.selector_id::STRING <> k.keep_id
)
UPDATE run_events SET selector_id = d.keep_id FROM dupes d WHERE run_events.selector_id = d.drop_id;

-- 2. Drop the duplicates.
DELETE FROM selectors
WHERE selector_id::STRING NOT IN (
  SELECT min(selector_id::STRING) FROM selectors
  GROUP BY app_id, role, name, frame_hint
);

-- 3. Normalize, now that nothing collides.
UPDATE selectors SET role = '' WHERE role IS NULL;
UPDATE selectors SET name = '' WHERE name IS NULL;

-- 4. Make the constraint enforceable across every one of its columns.
ALTER TABLE selectors ALTER COLUMN role SET DEFAULT '';
ALTER TABLE selectors ALTER COLUMN role SET NOT NULL;
ALTER TABLE selectors ALTER COLUMN name SET DEFAULT '';
ALTER TABLE selectors ALTER COLUMN name SET NOT NULL;
