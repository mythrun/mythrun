import { describe, it, expect } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractSchema } from '../schemaExtractor.ts'

const databaseUrl = process.env.WIKI_DATABASE_URL ?? process.env.DATABASE_URL ?? ''

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(here, '../../../../backend/migrations')

describe.skipIf(databaseUrl === '')('extractSchema (integration)', () => {
  it('returns metadata for every application table, with cluster assignments', async () => {
    const meta = await extractSchema({
      databaseUrl,
      migrationsDir,
    })

    // 35 application tables + 3 SRD = 38, minus _migrations which we hide = 38 in metadata.
    // We assert ≥35 to leave room for future migrations.
    expect(meta.tables.length).toBeGreaterThanOrEqual(35)

    // _migrations must not appear.
    const names = meta.tables.map((t) => t.name)
    expect(names).not.toContain('_migrations')

    // Spot-check a representative table from each cluster.
    const facts = meta.tables.find((t) => t.name === 'facts')
    expect(facts).toBeDefined()
    expect(facts?.cluster).toBe('Worlds & entities')
    expect(facts?.columns.length).toBeGreaterThan(0)

    const users = meta.tables.find((t) => t.name === 'users')
    expect(users?.cluster).toBe('Identity & billing')

    const sessions = meta.tables.find((t) => t.name === 'sessions')
    expect(sessions?.cluster).toBe('Campaigns & play')

    // sessions has the partial-unique index.
    const sessionsIdx = sessions?.indexes.find((i) => i.name === 'idx_sessions_one_active')
    expect(sessionsIdx?.predicate).toContain("status = 'active'")

    // facts has the access_level CHECK.
    expect(facts?.checks.some((c) => c.clause.includes('access_level'))).toBe(true)

    // entities has a CASCADE FK to worlds.
    const entities = meta.tables.find((t) => t.name === 'entities')
    const worldFk = entities?.fks.find((f) => f.column === 'world_id')
    expect(worldFk).toEqual({
      column: 'world_id',
      foreignTable: 'worlds',
      foreignColumn: 'id',
      deleteRule: 'CASCADE',
    })

    // No table is in the 'Other' cluster (the static map covers all current tables).
    const others = meta.tables.filter((t) => t.cluster === 'Other')
    expect(others).toEqual([])
  })

  it('surfaces named UNIQUE constraint indexes (not just idx_*), and excludes primary keys', async () => {
    const meta = await extractSchema({ databaseUrl, migrationsDir })

    // migration 022 adds a named UNIQUE constraint whose backing index is
    // `session_preps_campaign_session_key` — NOT an idx_* name. The old
    // `indexname LIKE 'idx_%'` filter dropped it; it must now appear.
    const sessionPreps = meta.tables.find((t) => t.name === 'session_preps')
    const uniqueIdx = sessionPreps?.indexes.find(
      (i) => i.name === 'session_preps_campaign_session_key',
    )
    expect(uniqueIdx).toBeDefined()
    expect(uniqueIdx?.unique).toBe(true)
    expect(uniqueIdx?.columns).toEqual(['campaign_id', 'session_number'])

    // Inline column-level UNIQUE constraints (the `<table>_<col>_key` form) also
    // surface — e.g. users.cognito_sub is UNIQUE.
    const users = meta.tables.find((t) => t.name === 'users')
    expect(users?.indexes.some((i) => i.unique && i.columns.includes('cognito_sub'))).toBe(true)

    // Primary-key backing indexes (`<table>_pkey`) remain excluded — every
    // table has one on `id`; they'd be uniform noise.
    const anyPkey = meta.tables.some((t) => t.indexes.some((i) => i.name.endsWith('_pkey')))
    expect(anyPkey).toBe(false)
  })

  it('pairs FK columns correctly for composite + multi-FK tables (no information_schema cross-product)', async () => {
    const meta = await extractSchema({ databaseUrl, migrationsDir })
    const cc = meta.tables.find((t) => t.name === 'character_concepts')
    expect(cc).toBeDefined()

    // character_concepts has 3 FK constraints → 4 column-level FK pairs:
    // campaign_id→campaigns(id), user_id→users(id), and the composite
    // (campaign_id,user_id)→campaign_members(campaign_id,user_id) contributing
    // two positionally-paired rows. The old kcu⋈ccu cross-product inflated this
    // to dozens (the rendered meta showed "48 FKs").
    expect(cc?.fks.length).toBe(4)

    // Composite FK columns must be paired POSITIONALLY:
    // campaign_id→campaign_members.campaign_id and user_id→campaign_members.user_id.
    // The bug mispaired them (e.g. campaign_id→campaign_members.user_id).
    const toMembers = (cc?.fks ?? []).filter((f) => f.foreignTable === 'campaign_members')
    expect(toMembers).toHaveLength(2)
    expect(toMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'campaign_id', foreignColumn: 'campaign_id' }),
        expect.objectContaining({ column: 'user_id', foreignColumn: 'user_id' }),
      ]),
    )

    // The per-column "References" cell prefers the single-column FK:
    // campaign_id→campaigns(id), user_id→users(id).
    const campaignCol = cc?.columns.find((c) => c.name === 'campaign_id')
    expect(campaignCol?.fk).toEqual({
      column: 'campaign_id',
      foreignTable: 'campaigns',
      foreignColumn: 'id',
      deleteRule: 'CASCADE',
    })
    const userCol = cc?.columns.find((c) => c.name === 'user_id')
    expect(userCol?.fk?.foreignTable).toBe('users')
    expect(userCol?.fk?.foreignColumn).toBe('id')
  })

  it('cleans up the throwaway schema after extraction', async () => {
    await extractSchema({
      databaseUrl,
      migrationsDir,
    })
    // A second call must succeed — proves the schema was dropped, not left behind in a half-applied state.
    await extractSchema({
      databaseUrl,
      migrationsDir,
    })
  })
})
