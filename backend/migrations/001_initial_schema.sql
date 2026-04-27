-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- UUIDv7 generation function (application-side is preferred, but this provides a DB-level fallback)
-- In practice, UUIDv7 is generated in application code using a library like 'uuid' v10+

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  cognito_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  auth_provider TEXT NOT NULL CHECK (auth_provider IN ('google', 'discord')),
  stripe_customer_id TEXT UNIQUE,
  free_trial_used BOOLEAN NOT NULL DEFAULT false,
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credit Ledger (replaces simple session_credits integer)
CREATE TABLE credit_ledger (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credit_type TEXT NOT NULL CHECK (credit_type IN ('session', 'world_gen')),
  amount INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('purchase', 'subscription', 'gift', 'trial', 'refund', 'debit')),
  source_id UUID,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX idx_credit_ledger_user_type ON credit_ledger(user_id, credit_type, expires_at);

-- Worlds
CREATE TABLE worlds (
  id UUID PRIMARY KEY,
  created_by UUID NOT NULL REFERENCES users(id),
  source_world_id UUID REFERENCES worlds(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  concept TEXT NOT NULL,
  tone TEXT,
  themes TEXT,
  geography_summary TEXT,
  political_summary TEXT,
  era TEXT,
  key_tensions TEXT,
  world_overview TEXT,
  follow_up_questions TEXT,
  starting_situations TEXT,
  is_public BOOLEAN NOT NULL DEFAULT false,
  fork_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'complete', 'failed')),
  language TEXT NOT NULL DEFAULT 'en',
  moderation_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (moderation_status IN ('unreviewed', 'approved', 'flagged', 'removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Campaigns
CREATE TABLE campaigns (
  id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  source_world_id UUID REFERENCES worlds(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'archived')),
  language TEXT NOT NULL DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Campaign Members
CREATE TABLE campaign_members (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'player')),
  invite_accepted BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, user_id)
);

-- Campaign Invites
CREATE TABLE campaign_invites (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stat Blocks
CREATE TABLE stat_blocks (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  cr TEXT,
  armor_class INTEGER NOT NULL,
  hit_points INTEGER NOT NULL,
  hit_dice TEXT,
  speed TEXT NOT NULL,
  str INTEGER NOT NULL,
  dex INTEGER NOT NULL,
  con INTEGER NOT NULL,
  int INTEGER NOT NULL,
  wis INTEGER NOT NULL,
  cha INTEGER NOT NULL,
  skills TEXT,
  senses TEXT,
  languages TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stat_block_actions (
  id UUID PRIMARY KEY,
  stat_block_id UUID NOT NULL REFERENCES stat_blocks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('action', 'reaction', 'bonus_action', 'legendary')),
  description TEXT NOT NULL
);

-- Entities (belong to worlds, not campaigns)
CREATE TABLE entities (
  id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('npc', 'location', 'faction', 'item')),
  name TEXT NOT NULL,
  stat_block_id UUID REFERENCES stat_blocks(id) ON DELETE SET NULL,
  encountered BOOLEAN NOT NULL DEFAULT false,
  modified_by_play BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prose Kernels
CREATE TABLE prose_kernels (
  id UUID PRIMARY KEY,
  entity_id UUID NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Facts
CREATE TABLE facts (
  id UUID PRIMARY KEY,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  access_level TEXT NOT NULL CHECK (access_level IN ('public', 'private', 'secret')),
  narrative_status TEXT NOT NULL CHECK (narrative_status IN ('undelivered', 'delivered', 'developed', 'resolved')),
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'prep',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Relationships
CREATE TABLE relationships (
  id UUID PRIMARY KEY,
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity Hierarchy
CREATE TABLE entity_hierarchy (
  id UUID PRIMARY KEY,
  parent_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  child_entity_id UUID NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE
);

-- Random Tables
CREATE TABLE random_tables (
  id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE random_table_entries (
  id UUID PRIMARY KEY,
  table_id UUID NOT NULL REFERENCES random_tables(id) ON DELETE CASCADE,
  roll_min INTEGER NOT NULL,
  roll_max INTEGER NOT NULL,
  content TEXT NOT NULL
);

-- Characters
CREATE TABLE characters (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  class TEXT NOT NULL,
  species TEXT NOT NULL,
  background TEXT NOT NULL,
  str INTEGER NOT NULL,
  dex INTEGER NOT NULL,
  con INTEGER NOT NULL,
  int INTEGER NOT NULL,
  wis INTEGER NOT NULL,
  cha INTEGER NOT NULL,
  hit_points INTEGER NOT NULL,
  max_hit_points INTEGER NOT NULL,
  armor_class INTEGER NOT NULL,
  proficiency_bonus INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE character_skills (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  proficiency_level TEXT NOT NULL CHECK (proficiency_level IN ('none', 'proficient', 'expertise'))
);

CREATE TABLE character_features (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  feature_name TEXT NOT NULL,
  feature_source TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE character_equipment (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  equipped BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE character_spells (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  spell_name TEXT NOT NULL,
  spell_level INTEGER NOT NULL,
  prepared BOOLEAN NOT NULL DEFAULT false
);

-- Sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'crashed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  summary TEXT,
  st_running_summary TEXT,
  handoff TEXT
);

-- Session Messages (replaces transcript JSON blob)
CREATE TABLE session_messages (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  user_id UUID,
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session Participants
CREATE TABLE session_participants (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  character_id UUID NOT NULL REFERENCES characters(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, user_id)
);

-- Pipeline Runs
CREATE TABLE pipeline_runs (
  id UUID PRIMARY KEY,
  world_id UUID REFERENCES worlds(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd NUMERIC(10,6) DEFAULT 0,
  user_id UUID REFERENCES users(id)
);
-- Postgres table-level UNIQUE constraints accept only column lists, not
-- expressions, so the "one run per (world|campaign, stage, user)" invariant
-- ships as a UNIQUE INDEX. The COALESCE on user_id collapses NULL to a
-- sentinel UUID so two NULL-user rows for the same stage collide; without
-- it, NULL ≠ NULL would let multiple anonymous runs slip past.
CREATE UNIQUE INDEX idx_pipeline_runs_unique
  ON pipeline_runs (
    COALESCE(world_id, campaign_id),
    stage,
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- World Snapshots
CREATE TABLE world_snapshots (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data TEXT NOT NULL
);

-- Session Preps
CREATE TABLE session_preps (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_number INTEGER NOT NULL,
  ft_context TEXT NOT NULL,
  sd_playbook TEXT NOT NULL,
  snapshot_id UUID REFERENCES world_snapshots(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session Usage (cost tracking)
CREATE TABLE session_usage (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  user_id UUID NOT NULL REFERENCES users(id),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  budget_limit_tokens INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Purchases
CREATE TABLE purchases (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  stripe_payment_intent_id TEXT NOT NULL UNIQUE,
  session_pack_size INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- World Marketplace (schema-ready, not built at launch)
CREATE TABLE world_marketplace (
  id UUID PRIMARY KEY,
  world_id UUID NOT NULL UNIQUE REFERENCES worlds(id) ON DELETE CASCADE,
  listing_title TEXT NOT NULL,
  listing_description TEXT NOT NULL,
  tags TEXT[],
  creator_payout_cents INTEGER NOT NULL DEFAULT 0,
  listed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Moderation Flags (schema-ready, not built at launch)
CREATE TABLE moderation_flags (
  id UUID PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('world', 'session_message', 'user')),
  target_id UUID NOT NULL,
  reporter_id UUID REFERENCES users(id),
  reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Subscription Tiers (configuration)
CREATE TABLE subscription_tiers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,
  session_credits_per_month INTEGER NOT NULL,
  world_gen_credits_per_month INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User Subscriptions
CREATE TABLE user_subscriptions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL REFERENCES subscription_tiers(id),
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'unpaid')),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_subscriptions_user ON user_subscriptions(user_id);

-- Session Packs (configuration)
CREATE TABLE session_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  session_credits INTEGER NOT NULL,
  world_gen_credits INTEGER NOT NULL DEFAULT 0,
  stripe_price_id TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stripe Event Idempotency
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Settings
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
