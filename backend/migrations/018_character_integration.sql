-- backend/migrations/018_character_integration.sql
-- MYT-54: schema additions for character-integration single-pass pipeline.

-- 1) Owner-provided free-text relationship notes that go verbatim into the
--    character-integration prompt header.
ALTER TABLE campaigns ADD COLUMN pre_integration_notes TEXT
  CHECK (pre_integration_notes IS NULL OR length(pre_integration_notes) <= 4000);

-- 2) Persist MYT-53 stage 2's CharacterConceptOutput so the MYT-54 single-pass
--    worker can read the narrative pieces. JSONB so shape can evolve.
ALTER TABLE character_concepts ADD COLUMN concept_output JSONB
  CHECK (concept_output IS NULL OR jsonb_typeof(concept_output) = 'object');

-- 3) Extend status enum with 'integrated'.
ALTER TABLE character_concepts DROP CONSTRAINT IF EXISTS character_concepts_status_check;
ALTER TABLE character_concepts ADD CONSTRAINT character_concepts_status_check
  CHECK (status IN ('submitted', 'processing', 'completed', 'failed', 'integrated'));

-- 4) Partial unique index for campaign-scoped pipeline_runs claims.
--    SKIPPED: migration 001 already creates idx_pipeline_runs_unique on
--    (COALESCE(world_id, campaign_id), stage, COALESCE(user_id, sentinel))
--    which functionally subsumes a partial unique index on
--    (campaign_id, stage) WHERE user_id IS NULL — for a campaign-scoped row
--    with NULL user_id, the existing index already enforces uniqueness on
--    (campaign_id, stage, sentinel_uuid). Adding a redundant partial index
--    would double-write on every insert without strengthening the invariant.
