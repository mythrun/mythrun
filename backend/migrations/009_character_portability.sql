-- 009_character_portability.sql
-- MYT-48: characters become user-owned with a campaign_characters join.
--
-- Day-one runtime behavior: one character per user per campaign, enforced
-- by UNIQUE (campaign_id, user_id) on the join table. The schema permits
-- one character_id to join multiple campaign_ids in the future (portability);
-- the launch UX never exposes that path.
--
-- Greenfield: characters is empty in dev / staging. No backfill needed.

-- 1. characters.user_id was nullable from migration 001. Lock it down now
--    that ownership lives on the row, not the campaign FK.
ALTER TABLE characters ALTER COLUMN user_id SET NOT NULL;

-- 2. Drop the campaign_id FK + column. Membership lives in campaign_characters.
ALTER TABLE characters DROP CONSTRAINT characters_campaign_id_fkey;
ALTER TABLE characters DROP COLUMN campaign_id;

-- 3. Join table. UNIQUE (campaign_id, character_id) prevents adding the same
--    character twice to one campaign. UNIQUE (campaign_id, user_id) enforces
--    the day-one "one PC per player per campaign" rule.
CREATE TABLE campaign_characters (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, character_id),
  UNIQUE (campaign_id, user_id)
);

CREATE INDEX idx_campaign_characters_user ON campaign_characters(user_id);
CREATE INDEX idx_campaign_characters_character ON campaign_characters(character_id);

-- Post-migration assertion. Schema-scoped to current_schema() per migration
-- 005's pattern (wiki-extractor introspection uses a throwaway schema).
DO $$ BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'characters'
      AND column_name = 'campaign_id'
  ), 'characters.campaign_id was not dropped';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'characters'
      AND column_name = 'user_id'
      AND is_nullable = 'NO'
  ), 'characters.user_id was not set NOT NULL';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'campaign_characters'
  ), 'campaign_characters table was not created';

  ASSERT (
    SELECT count(*) FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'campaign_characters'
      AND indexname IN (
        'campaign_characters_campaign_id_character_id_key',
        'campaign_characters_campaign_id_user_id_key',
        'idx_campaign_characters_user',
        'idx_campaign_characters_character'
      )
  ) = 4, 'campaign_characters indexes were not all created';
END $$;
