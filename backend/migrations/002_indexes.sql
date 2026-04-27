-- Entity queries by world and type (hot path for Scribe, ST, session loading)
CREATE INDEX idx_entities_world_type ON entities(world_id, entity_type);
CREATE INDEX idx_entities_world ON entities(world_id);

-- Fact queries filtered by access level and narrative status
CREATE INDEX idx_facts_entity ON facts(entity_id);
CREATE INDEX idx_facts_entity_access_status ON facts(entity_id, access_level, narrative_status);

-- Relationship lookups
CREATE INDEX idx_relationships_source ON relationships(source_entity_id);
CREATE INDEX idx_relationships_target ON relationships(target_entity_id);

-- Session messages ordered replay
CREATE INDEX idx_session_messages_session_seq ON session_messages(session_id, seq);

-- Campaign lookups
CREATE INDEX idx_campaigns_created_by ON campaigns(created_by);
CREATE INDEX idx_campaign_members_user ON campaign_members(user_id);
CREATE INDEX idx_campaign_members_campaign ON campaign_members(campaign_id);

-- Session lookups
CREATE INDEX idx_sessions_campaign ON sessions(campaign_id);
CREATE INDEX idx_session_preps_campaign ON session_preps(campaign_id);

-- Prevent duplicate active sessions per campaign
CREATE UNIQUE INDEX idx_sessions_one_active ON sessions(campaign_id) WHERE status = 'active';

-- Pipeline tracking
CREATE INDEX idx_pipeline_runs_world ON pipeline_runs(world_id);
CREATE INDEX idx_pipeline_runs_campaign ON pipeline_runs(campaign_id);

-- Random tables
CREATE INDEX idx_random_tables_world ON random_tables(world_id);

-- Characters
CREATE INDEX idx_characters_campaign ON characters(campaign_id);
CREATE INDEX idx_characters_user ON characters(user_id);

-- World snapshots
CREATE INDEX idx_world_snapshots_campaign ON world_snapshots(campaign_id);

-- Purchases
CREATE INDEX idx_purchases_user ON purchases(user_id);
