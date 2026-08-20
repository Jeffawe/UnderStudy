-- Selectors: one row per ELEMENT, including unnamed ones.
--
-- db/02 and db/04 made role/name/frame_hint NOT NULL because a NULL component
-- made UNIQUE(app_id, role, name, frame_hint) inert. Correct fix, but it left
-- the opposite defect: every element WITHOUT an accessible name now shares the
-- key ('', '', ''), so they all merge into a single row.
--
-- Measured on providernow before this migration: 92 steps pointing at 2 rows,
-- one holding 52 distinct elements. That breaks the health model (52 elements,
-- one score — quarantine would remove all of them or none) and actively
-- corrupts execution, because execute.ts reads `css` from this table and was
-- handing one element's '.review-pane' to fifty-one others.
--
-- `identity` is computed by src/core/selector-identity.ts: the accessible name
-- when there is one (byte-identical to the OLD key, so named elements are
-- unaffected), else the test id, else the css. An element with none of the
-- three gets NO row at all — the writers pass selector_id = NULL.
--
-- NOTE ON HISTORY: this cannot UN-merge rows that already merged. The per-
-- element css was overwritten when they collapsed, and that information is
-- gone. Existing rows are given a unique identity so the constraint can be
-- built; re-ingesting a recording rebuilds its selectors correctly.

ALTER TABLE selectors ADD COLUMN IF NOT EXISTS identity STRING NOT NULL DEFAULT '';

-- Backfill mirrors selectorIdentity(), with one addition: rows that fall
-- through every rule get their own selector_id, because two rows that cannot
-- be told apart still must not collide when the unique index is built.
UPDATE selectors SET identity =
  CASE
    WHEN name <> ''       THEN role || '|' || name || '|' || frame_hint
    WHEN test_id IS NOT NULL THEN role || '|' || frame_hint || '|#testid:' || test_id
    WHEN css IS NOT NULL     THEN role || '|' || frame_hint || '|#css:' || css
    ELSE role || '|' || frame_hint || '|#sel:' || selector_id::STRING
  END
WHERE identity = '';

-- Order matters: backfill BEFORE the unique index exists, or the update
-- creates the very collision it is meant to remove. Same lesson as db/02.
ALTER TABLE selectors DROP CONSTRAINT IF EXISTS selectors_app_id_role_name_frame_hint_key;

CREATE UNIQUE INDEX IF NOT EXISTS selectors_identity_key ON selectors (app_id, identity);
