-- Migration 01 — give memory_chunks.app_id the foreign key every other
-- app-scoped table already had.
--
-- WHY: `DELETE FROM apps` cascaded pages, page_edges, selectors, and facts but
-- left memory_chunks untouched, because it was the one table declaring app_id
-- as a bare UUID. Orphaned chunks are invisible to every query (recall filters
-- by app_id), permanent, and on CockroachDB Cloud they are billable storage
-- inside a 10 GiB cap. Twenty had already accumulated from two re-runs.
--
-- schema.sql now declares this inline, so FRESH clusters need nothing. This
-- file is only for clusters created before 2026-08-06.
--
-- Apply:  TARGET=local ./scripts/db.sh -f db/01-memory-chunks-fk.sql
--         TARGET=cloud ./scripts/db.sh -f db/01-memory-chunks-fk.sql
--
-- Safe to re-run: the delete is a no-op once clean, and ADD CONSTRAINT IF NOT
-- EXISTS is a no-op once the constraint is there.

-- The constraint cannot validate while orphans exist, so clear them first.
-- This deletes ONLY chunks whose app is already gone.
DELETE FROM memory_chunks
WHERE app_id NOT IN (SELECT app_id FROM apps);

ALTER TABLE memory_chunks
  ADD CONSTRAINT IF NOT EXISTS fk_memory_chunks_app
  FOREIGN KEY (app_id) REFERENCES apps(app_id) ON DELETE CASCADE;
