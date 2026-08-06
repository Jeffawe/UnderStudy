-- Run this ONCE per cluster, BEFORE schema.sql.
-- Separated from schema.sql because on CockroachDB Cloud Basic you may not
-- have permission to change cluster settings — and if this fails inside
-- schema.sql, nothing after it executes.
--
-- If this errors on Cloud:
--   1. Check whether it's already on:
--        SHOW CLUSTER SETTING feature.vector_index.enabled;
--   2. If it's on by default, skip this file and apply schema.sql.
--   3. If it's off and you can't set it, vector indexes are unavailable —
--      strip the VECTOR INDEX clause from memory_chunks and run exact scans.
--      The retrieval query is IDENTICAL either way; only acceleration is lost.

SET CLUSTER SETTING feature.vector_index.enabled = true;
