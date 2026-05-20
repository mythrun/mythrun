-- backend/migrations/017_entity_consolidation.sql
--
-- myth-tt2g / entity_consolidation stage (spec: 2026-05-20-phantom-
-- reference-reconciliation-design.md §2).
--
-- 1. entities.created_in — generic provenance column for entity
--    creation source. Stages 2-3 set 'stage:<name>'; stage 4b sets
--    'stage:entity_consolidation'; future Scribe creation during
--    play sets 'session:<uuid>'. The DEFAULT clause backfills every
--    existing row to 'stage:legacy' during ALTER — no separate
--    UPDATE statement needed.
--
-- 2. worlds.entity_consolidation_pending — inter-stage handoff
--    between stage 4 (entity_relationships) and stage 4b
--    (entity_consolidation). Stage 4 writes the pending phantom
--    declarations + relationships; stage 4b reads, processes, then
--    clears back to the populated-shape default. Pattern mirrors
--    worlds.starting_situation_entries from migration 016.

ALTER TABLE entities
  ADD COLUMN created_in TEXT NOT NULL DEFAULT 'stage:legacy';

ALTER TABLE worlds
  ADD COLUMN entity_consolidation_pending JSONB NOT NULL
    DEFAULT '{"declarations": [], "relationships": []}'::jsonb;

ALTER TABLE worlds
  ADD CONSTRAINT worlds_entity_consolidation_pending_shape
  CHECK (
    jsonb_typeof(entity_consolidation_pending) = 'object'
    AND jsonb_typeof(entity_consolidation_pending->'declarations') = 'array'
    AND jsonb_typeof(entity_consolidation_pending->'relationships') = 'array'
  );
