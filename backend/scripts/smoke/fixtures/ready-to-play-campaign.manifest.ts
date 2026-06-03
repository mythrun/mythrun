import type { FixtureManifest } from './types.js'

export const READY_TO_PLAY_MANIFEST: FixtureManifest = {
  name: 'ready-to-play-campaign',
  tables: [
    // Shared: all member users (owner + players). globalSetup seeds dev users; ON CONFLICT DO NOTHING.
    { name: 'users', shared: true, filter: (ids) => ({ sql: 'id IN (SELECT user_id FROM campaign_members WHERE campaign_id = $1)', params: [ids.campaignId] }) },
    { name: 'stat_blocks', filter: (ids) => ({ sql: 'id IN (SELECT stat_block_id FROM entities WHERE world_id = $1 AND stat_block_id IS NOT NULL)', params: [ids.worldId] }) },
    { name: 'worlds', filter: (ids) => ({ sql: 'id = $1', params: [ids.worldId] }) },
    { name: 'entities', filter: (ids) => ({ sql: 'world_id = $1', params: [ids.worldId] }) },
    { name: 'prose_kernels', filter: (ids) => ({ sql: 'entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'facts', filter: (ids) => ({ sql: 'entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'relationships', filter: (ids) => ({ sql: 'source_entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'entity_hierarchy', filter: (ids) => ({ sql: 'parent_entity_id IN (SELECT id FROM entities WHERE world_id = $1)', params: [ids.worldId] }) },
    { name: 'campaigns', filter: (ids) => ({ sql: 'id = $1', params: [ids.campaignId] }) },
    { name: 'characters', filter: (ids) => ({ sql: 'id IN (SELECT character_id FROM campaign_characters WHERE campaign_id = $1)', params: [ids.campaignId] }) },
    { name: 'campaign_members', filter: (ids) => ({ sql: 'campaign_id = $1', params: [ids.campaignId] }) },
    { name: 'campaign_characters', filter: (ids) => ({ sql: 'campaign_id = $1', params: [ids.campaignId] }) },
  ],
}
