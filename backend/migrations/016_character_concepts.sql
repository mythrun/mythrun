-- backend/migrations/016_character_concepts.sql
-- MYT-53: per-player character submission input + adjacent schema additions
-- supporting the per-player character-creation pipeline.
--
-- One row per (campaign_id, user_id) in character_concepts. Pre-fan-out
-- it holds the player's input; post-fan-out it tracks status. Consumed
-- by the character-creation worker on owner-triggered fan-out.
--
-- The composite FK to campaign_members ensures membership integrity:
-- if a member is removed from the campaign, their concept row cascades.
-- campaign_members already has UNIQUE(campaign_id, user_id) (001_initial_schema).
--
-- entity_type='pc' is added so PC entities are conceptually distinct
-- from NPC entities, keeping existing "list NPCs" paths clean.

-- 1) Owner's starting-situation pick (per-campaign, applied party-wide).
ALTER TABLE campaigns ADD COLUMN starting_situation_index SMALLINT
  CHECK (starting_situation_index IS NULL
         OR starting_situation_index BETWEEN 0 AND 2);

-- 2) Structured starting-situation entries on the world. Stage
-- starting_situation extends to emit this alongside the existing prose
-- blob (worlds.starting_situations). GET /starting-situations reads
-- this column.
ALTER TABLE worlds ADD COLUMN starting_situation_entries jsonb NOT NULL
  DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(starting_situation_entries) = 'array');

-- 3) Extend entities.entity_type to allow 'pc'. PCs are user-owned
-- characters joined to the world; NPCs remain pure game-fiction.
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_entity_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_entity_type_check
  CHECK (entity_type IN ('npc', 'location', 'faction', 'item', 'pc'));

-- 4) The character_concepts table.
CREATE TABLE character_concepts (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Composite FK to campaign_members: a concept row only makes sense
  -- for a current member of the campaign. ON DELETE CASCADE means
  -- removing a member cascades the concept row out automatically.
  FOREIGN KEY (campaign_id, user_id)
    REFERENCES campaign_members(campaign_id, user_id) ON DELETE CASCADE,

  -- Freeform mode input. The "who is this character?" half. NULL
  -- only when the player is purely-guided (future).
  concept_text TEXT
    CHECK (concept_text IS NULL OR length(concept_text) BETWEEN 20 AND 4000),

  -- "Why is this character at this tavern?" half. Always required in v1.
  -- Late-joiner UX reuses this field with a reworded prompt.
  situation_grounding_text TEXT NOT NULL
    CHECK (length(situation_grounding_text) BETWEEN 20 AND 2000),

  -- Guided mode input. JSONB so shape can evolve. Always {} in v1.
  guided_choices JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Submission lifecycle.
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'processing', 'completed', 'failed')),

  error JSONB,

  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(campaign_id, user_id)
);

CREATE INDEX idx_character_concepts_campaign_status
  ON character_concepts(campaign_id, status);

-- 5) Cost-cap row for character creation. Default $5.00 — covers
-- ~10 players at the realistic per-player upper end (~$0.50) with
-- headroom. Mirrors world_gen_cost_cap_usd shape from migration 010.
INSERT INTO settings (key, value)
  VALUES ('character_creation_cost_cap_usd', '5.00')
  ON CONFLICT (key) DO NOTHING;
