-- backend/migrations/026_world_retrieval.sql
-- MYT-71 §3 — pgvector substrate for the world-store retrieval resolver.
--
-- PRIVILEGE: the migrate role holds rds_superuser on RDS (migration 001 runs
-- `CREATE EXTENSION pgcrypto` through it), so CREATE EXTENSION vector is
-- authorized with no parameter-group change. PRECONDITION (§10): local docker +
-- CI Postgres must run pgvector/pgvector:pg16 — stock postgres:16-alpine does
-- NOT bundle `vector` (it bundles pgcrypto, a DIFFERENT contrib bundle, so 001
-- passing is no evidence `vector` is available). Migration 026's image swap (T1)
-- lands first.
--
-- Runner wraps this file in a single BEGIN/COMMIT; NO top-level transaction
-- control here, and NO CREATE INDEX CONCURRENTLY (it cannot run in a tx).
CREATE EXTENSION IF NOT EXISTS vector;

-- Embeddings live on the rows they describe. Nullable — backfillable; a NULL
-- embedding row is simply unsearchable until (re-)embedded, never a crash (§4.3).
-- `embedded_at` lets the backfill find rows whose content changed after
-- embedding (drift detection), not only NULL rows.
ALTER TABLE facts    ADD COLUMN embedding vector(512), ADD COLUMN embedded_at TIMESTAMPTZ;
ALTER TABLE entities ADD COLUMN embedding vector(512), ADD COLUMN embedded_at TIMESTAMPTZ;

-- HNSW (not IVFFlat): higher recall, no training step, correct for the
-- INCREMENTAL inserts the Scribe does at session end (IVFFlat needs a populated
-- table to train its lists). Cosine ops. NULL embeddings are not indexed.
CREATE INDEX idx_facts_embedding    ON facts    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_entities_embedding ON entities USING hnsw (embedding vector_cosine_ops);
