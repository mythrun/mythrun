# MYT-48 — Character Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `characters` to a user-owned shape and add a `campaign_characters` join table, plus a `repo.characters` namespace with `create` / `addToCampaign` / `listForCampaign` / `findUserCharacterForCampaign`. Schema is decoupled today; runtime behavior matches "one character per user per campaign" via a UNIQUE constraint.

**Architecture:** Single migration (`009_character_portability.sql`) drops `characters.campaign_id`, makes `user_id` NOT NULL, and creates the join table. A new repo namespace (`backend/src/repo/characters.ts`) exposes the four methods. Typed errors live in `backend/src/repo/characters-errors.ts`. Integration tests live in `backend/src/repo/__tests__/characters.test.ts` against the dev Postgres.

**Tech Stack:** PostgreSQL 16, `pg` driver, `vitest` for integration tests, TypeScript strict mode, namespace factory pattern (per `users.ts` / `campaigns.ts`).

**Spec:** `docs/superpowers/specs/2026-05-11-myt-48-character-portability-design.md`
**Worktree:** `.worktrees/myt-48-migration` on branch `myt-48-migration`

---

## Files

| Path | Action | Responsibility |
|---|---|---|
| `backend/migrations/009_character_portability.sql` | Create | Schema migration: drop `characters.campaign_id`, NOT NULL `characters.user_id`, create `campaign_characters` + indexes, assert. |
| `backend/src/repo/types.ts` | Modify | Add `Character`, `CampaignCharacter`, `CreateCharacterInput` interfaces. |
| `backend/src/repo/mappers.ts` | Modify | Add `CharacterDbRow` / `toCharacter`, `CampaignCharacterDbRow` / `toCampaignCharacter`. |
| `backend/src/repo/characters-errors.ts` | Create | `CharacterAlreadyInCampaignError`, `UserAlreadyHasCharacterInCampaignError`. |
| `backend/src/repo/characters.ts` | Create | `createCharactersRepo(pool)` factory with the four methods. |
| `backend/src/repo/index.ts` | Modify | Register `characters: createCharactersRepo(pool)` in `createRepo`. |
| `backend/src/repo/__tests__/_helpers/reset-data.ts` | Modify | Append `'campaign_characters'` to the TRUNCATE list. |
| `backend/src/repo/__tests__/characters.test.ts` | Create | Integration tests for all four methods + both UNIQUE-violation paths. |
| `docs/wiki/content/data/schema.html` | Modify | Update `characters` description + index list to reflect the new shape. |

---

## Task 1: Migration 009 — schema changes

**Files:**
- Create: `backend/migrations/009_character_portability.sql`

- [ ] **Step 1: Write the migration**

Create `backend/migrations/009_character_portability.sql` with the following content:

```sql
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
```

- [ ] **Step 2: Apply migration against dev Postgres**

Run: `pnpm migrate:run`

Expected: prints `[migrate.done]` with `applied: 1`, listing `009_character_portability.sql`. Exit code 0.

- [ ] **Step 3: Verify schema state**

Run:
```bash
psql "$DATABASE_URL" -c "\d characters" | grep -E "campaign_id|user_id"
psql "$DATABASE_URL" -c "\d campaign_characters"
```

Expected: `characters` shows `user_id` as `not null` and NO `campaign_id` column. `campaign_characters` exists with 4 columns + 2 unique constraints + 2 indexes.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/009_character_portability.sql
git commit -m "feat(myt-48): migration 009 — character portability"
```

---

## Task 2: Types + mappers

**Files:**
- Modify: `backend/src/repo/types.ts`
- Modify: `backend/src/repo/mappers.ts`

- [ ] **Step 1: Add interfaces to `types.ts`**

Append the following to `backend/src/repo/types.ts` (after the existing exports — find the end of file):

```ts
export interface Character {
  readonly id: string
  readonly userId: string
  readonly entityId: string | null
  readonly name: string
  readonly level: number
  readonly class: string
  readonly species: string
  readonly background: string
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly hitPoints: number
  readonly maxHitPoints: number
  readonly armorClass: number
  readonly proficiencyBonus: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateCharacterInput {
  readonly userId: string
  readonly name: string
  readonly level: number
  readonly class: string
  readonly species: string
  readonly background: string
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly hitPoints: number
  readonly maxHitPoints: number
  readonly armorClass: number
  readonly proficiencyBonus: number
}

export interface CampaignCharacter {
  readonly id: string
  readonly campaignId: string
  readonly characterId: string
  readonly userId: string
  readonly joinedAt: Date
}
```

- [ ] **Step 2: Add mappers to `mappers.ts`**

Append the following to `backend/src/repo/mappers.ts`:

```ts
import type { Character, CampaignCharacter } from './types.js'

export interface CharacterDbRow {
  readonly id: string
  readonly user_id: string
  readonly entity_id: string | null
  readonly name: string
  readonly level: number
  readonly class: string
  readonly species: string
  readonly background: string
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly hit_points: number
  readonly max_hit_points: number
  readonly armor_class: number
  readonly proficiency_bonus: number
  readonly created_at: Date
  readonly updated_at: Date
}

export function toCharacter(row: CharacterDbRow): Character {
  return {
    id: row.id,
    userId: row.user_id,
    entityId: row.entity_id,
    name: row.name,
    level: row.level,
    class: row.class,
    species: row.species,
    background: row.background,
    str: row.str,
    dex: row.dex,
    con: row.con,
    int: row.int,
    wis: row.wis,
    cha: row.cha,
    hitPoints: row.hit_points,
    maxHitPoints: row.max_hit_points,
    armorClass: row.armor_class,
    proficiencyBonus: row.proficiency_bonus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface CampaignCharacterDbRow {
  readonly id: string
  readonly campaign_id: string
  readonly character_id: string
  readonly user_id: string
  readonly joined_at: Date
}

export function toCampaignCharacter(row: CampaignCharacterDbRow): CampaignCharacter {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    characterId: row.character_id,
    userId: row.user_id,
    joinedAt: row.joined_at,
  }
}
```

Note: if the existing `mappers.ts` already imports `type {...}` from `'./types.js'`, merge the `Character, CampaignCharacter` names into that existing import line instead of adding a duplicate import.

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm --filter backend typecheck`

Expected: exit 0. No errors related to `Character` or `CampaignCharacter`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/repo/types.ts backend/src/repo/mappers.ts
git commit -m "feat(myt-48): Character + CampaignCharacter types and mappers"
```

---

## Task 3: Typed errors module

**Files:**
- Create: `backend/src/repo/characters-errors.ts`

- [ ] **Step 1: Create the errors module**

Create `backend/src/repo/characters-errors.ts`:

```ts
// backend/src/repo/characters-errors.ts
//
// Custom Error subclasses thrown by repo.characters.

export class CharacterAlreadyInCampaignError extends Error {
  readonly code = 'CHARACTER_ALREADY_IN_CAMPAIGN'
  constructor(
    readonly campaignId: string,
    readonly characterId: string,
  ) {
    super(`Character ${characterId} is already in campaign ${campaignId}`)
    this.name = 'CharacterAlreadyInCampaignError'
  }
}

export class UserAlreadyHasCharacterInCampaignError extends Error {
  readonly code = 'USER_ALREADY_HAS_CHARACTER_IN_CAMPAIGN'
  constructor(
    readonly campaignId: string,
    readonly userId: string,
  ) {
    super(`User ${userId} already has a character in campaign ${campaignId}`)
    this.name = 'UserAlreadyHasCharacterInCampaignError'
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter backend typecheck`

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add backend/src/repo/characters-errors.ts
git commit -m "feat(myt-48): typed errors for characters repo"
```

---

## Task 4: `characters.create` — TDD

**Files:**
- Create: `backend/src/repo/__tests__/characters.test.ts`
- Create: `backend/src/repo/characters.ts`
- Modify: `backend/src/repo/__tests__/_helpers/reset-data.ts`

- [ ] **Step 1: Append `'campaign_characters'` to the TRUNCATE list**

In `backend/src/repo/__tests__/_helpers/reset-data.ts`, find the `// Campaigns + characters` section and append `'campaign_characters'` after `'campaign_invites'`. The block should read:

```ts
  // Campaigns + characters
  'campaigns',
  'campaign_members',
  'campaign_invites',
  'campaign_characters',
  'characters',
  'character_skills',
  'character_features',
  'character_equipment',
  'character_spells',
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/repo/__tests__/characters.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createCharactersRepo } from '../characters.js'
import {
  CharacterAlreadyInCampaignError,
  UserAlreadyHasCharacterInCampaignError,
} from '../characters-errors.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard log output
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

const baseCharacterInput = {
  name: 'Aila Thornwood',
  level: 1,
  class: 'Ranger',
  species: 'Half-Elf',
  background: 'Outlander',
  str: 12,
  dex: 16,
  con: 13,
  int: 11,
  wis: 14,
  cha: 10,
  hitPoints: 11,
  maxHitPoints: 11,
  armorClass: 14,
  proficiencyBonus: 2,
}

describe('repo.characters', () => {
  let pool: Pool
  let userId: string
  let _campaignId: string

  beforeAll(async () => {
    guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl)
    await runMigrations({ pool, dir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)

    const users = createUsersRepo(pool)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const user = await users.create(client, {
        cognitoSub: 'g_player_a',
        username: 'aila',
        displayName: 'Aila',
      })
      await client.query('COMMIT')
      userId = user.id
    } finally {
      client.release()
    }

    const worlds = createWorldsRepo(pool)
    const world = await worlds.create({
      createdBy: userId,
      name: 'Test World',
      concept: 'A test world.',
    })

    const campaigns = createCampaignsRepo(pool)
    const campaign = await campaigns.create({
      worldId: world.id,
      createdBy: userId,
      name: 'Test Campaign',
    })
    _campaignId = campaign.id
  })

  describe('create', () => {
    it('returns a Character row matching the input', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let created
      try {
        await client.query('BEGIN')
        created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
      } finally {
        client.release()
      }

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(created.userId).toBe(userId)
      expect(created.name).toBe('Aila Thornwood')
      expect(created.level).toBe(1)
      expect(created.class).toBe('Ranger')
      expect(created.hitPoints).toBe(11)
      expect(created.maxHitPoints).toBe(11)
      expect(created.armorClass).toBe(14)
      expect(created.proficiencyBonus).toBe(2)
      expect(created.entityId).toBeNull()
    })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter backend test -- characters.test.ts`

Expected: fails because `../characters.js` does not exist (module-not-found error).

- [ ] **Step 4: Implement `characters.ts` minimally for `create`**

Create `backend/src/repo/characters.ts`:

```ts
import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { toCharacter, toCampaignCharacter } from './mappers.js'
import type { CharacterDbRow, CampaignCharacterDbRow } from './mappers.js'
import type { ClientLike } from './_types.js'
import type { Character, CampaignCharacter, CreateCharacterInput } from './types.js'
import {
  CharacterAlreadyInCampaignError,
  UserAlreadyHasCharacterInCampaignError,
} from './characters-errors.js'

export function createCharactersRepo(pool: Pool) {
  return {
    create: async (tx: ClientLike, input: CreateCharacterInput): Promise<Character> => {
      const id = uuidv7()
      const result = await tx.query<CharacterDbRow>(
        `INSERT INTO characters (
           id, user_id, name, level, class, species, background,
           str, dex, con, int, wis, cha,
           hit_points, max_hit_points, armor_class, proficiency_bonus
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [
          id,
          input.userId,
          input.name,
          input.level,
          input.class,
          input.species,
          input.background,
          input.str,
          input.dex,
          input.con,
          input.int,
          input.wis,
          input.cha,
          input.hitPoints,
          input.maxHitPoints,
          input.armorClass,
          input.proficiencyBonus,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('characters.create: INSERT returned no row')
      return toCharacter(row)
    },
  }
}
```

Note: this file references methods that don't exist yet (`addToCampaign`, `listForCampaign`, `findUserCharacterForCampaign`) only in imports — the imports themselves (`CampaignCharacter`, `toCampaignCharacter`, etc.) are unused at this step. That's fine; the next tasks fill them in. Linter may warn about unused imports — that's OK, lint runs at the end.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter backend test -- characters.test.ts`

Expected: 1 test passes (`returns a Character row matching the input`).

- [ ] **Step 6: Commit**

```bash
git add backend/src/repo/characters.ts backend/src/repo/__tests__/characters.test.ts \
  backend/src/repo/__tests__/_helpers/reset-data.ts
git commit -m "feat(myt-48): characters.create + first test"
```

---

## Task 5: `characters.addToCampaign` — TDD (3 cases)

**Files:**
- Modify: `backend/src/repo/__tests__/characters.test.ts`
- Modify: `backend/src/repo/characters.ts`

- [ ] **Step 1: Add the three failing tests**

In `backend/src/repo/__tests__/characters.test.ts`, append a new `describe('addToCampaign', ...)` block inside the existing `describe('repo.characters', ...)`:

```ts
  describe('addToCampaign', () => {
    it('inserts a join row on first call', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charId: string
      try {
        await client.query('BEGIN')
        const created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
        charId = created.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(_campaignId, charId, userId)

      const rows = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM campaign_characters
         WHERE campaign_id = $1 AND character_id = $2 AND user_id = $3`,
        [_campaignId, charId, userId],
      )
      expect(rows.rows[0]?.count).toBe('1')
    })

    it('throws CharacterAlreadyInCampaignError on duplicate (campaign_id, character_id)', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charId: string
      try {
        await client.query('BEGIN')
        const created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
        charId = created.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(_campaignId, charId, userId)

      await expect(characters.addToCampaign(_campaignId, charId, userId)).rejects.toBeInstanceOf(
        CharacterAlreadyInCampaignError,
      )
    })

    it('throws UserAlreadyHasCharacterInCampaignError when same user adds a different character', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charA: string
      let charB: string
      try {
        await client.query('BEGIN')
        const a = await characters.create(client, { userId, ...baseCharacterInput })
        const b = await characters.create(client, {
          userId,
          ...baseCharacterInput,
          name: 'Borin Stoneshield',
          class: 'Fighter',
        })
        await client.query('COMMIT')
        charA = a.id
        charB = b.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(_campaignId, charA, userId)

      await expect(characters.addToCampaign(_campaignId, charB, userId)).rejects.toBeInstanceOf(
        UserAlreadyHasCharacterInCampaignError,
      )
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test -- characters.test.ts`

Expected: 3 new tests fail because `characters.addToCampaign` is not a function.

- [ ] **Step 3: Implement `addToCampaign`**

In `backend/src/repo/characters.ts`, add the method inside the `return { ... }` object after `create`:

```ts
    addToCampaign: async (
      campaignId: string,
      characterId: string,
      userId: string,
    ): Promise<void> => {
      const id = uuidv7()
      try {
        await pool.query(
          `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
           VALUES ($1, $2, $3, $4)`,
          [id, campaignId, characterId, userId],
        )
      } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err && 'constraint' in err) {
          const pgErr = err as { code?: string; constraint?: string }
          if (pgErr.code === '23505') {
            if (pgErr.constraint === 'campaign_characters_campaign_id_character_id_key') {
              throw new CharacterAlreadyInCampaignError(campaignId, characterId)
            }
            if (pgErr.constraint === 'campaign_characters_campaign_id_user_id_key') {
              throw new UserAlreadyHasCharacterInCampaignError(campaignId, userId)
            }
          }
        }
        throw err
      }
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test -- characters.test.ts`

Expected: all 4 tests pass (1 create test + 3 addToCampaign tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/characters.ts backend/src/repo/__tests__/characters.test.ts
git commit -m "feat(myt-48): characters.addToCampaign with typed unique-violation errors"
```

---

## Task 6: `characters.listForCampaign` — TDD

**Files:**
- Modify: `backend/src/repo/__tests__/characters.test.ts`
- Modify: `backend/src/repo/characters.ts`

- [ ] **Step 1: Add the two failing tests**

Append a new `describe('listForCampaign', ...)` block:

```ts
  describe('listForCampaign', () => {
    it('returns characters joined to the campaign, ordered by join time', async () => {
      const characters = createCharactersRepo(pool)
      const users = createUsersRepo(pool)

      // Create a second user so we can have two PCs in the campaign
      const client = await pool.connect()
      let userBId: string
      let charA: string
      let charB: string
      try {
        await client.query('BEGIN')
        const userB = await users.create(client, {
          cognitoSub: 'g_player_b',
          username: 'borin',
          displayName: 'Borin',
        })
        userBId = userB.id

        const a = await characters.create(client, { userId, ...baseCharacterInput })
        const b = await characters.create(client, {
          userId: userBId,
          ...baseCharacterInput,
          name: 'Borin Stoneshield',
          class: 'Fighter',
        })
        await client.query('COMMIT')
        charA = a.id
        charB = b.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(_campaignId, charA, userId)
      await characters.addToCampaign(_campaignId, charB, userBId)

      const list = await characters.listForCampaign(_campaignId)

      expect(list).toHaveLength(2)
      expect(list.map((c) => c.id).sort()).toEqual([charA, charB].sort())
    })

    it('returns [] for a campaign with no characters', async () => {
      const characters = createCharactersRepo(pool)
      const list = await characters.listForCampaign(_campaignId)
      expect(list).toEqual([])
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test -- characters.test.ts`

Expected: 2 new tests fail because `listForCampaign` is not a function.

- [ ] **Step 3: Implement `listForCampaign`**

In `backend/src/repo/characters.ts`, add the method after `addToCampaign`:

```ts
    listForCampaign: async (campaignId: string): Promise<readonly Character[]> => {
      const result = await pool.query<CharacterDbRow>(
        `SELECT c.*
         FROM characters c
         JOIN campaign_characters cc ON cc.character_id = c.id
         WHERE cc.campaign_id = $1
         ORDER BY cc.joined_at ASC, cc.id ASC`,
        [campaignId],
      )
      return result.rows.map(toCharacter)
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test -- characters.test.ts`

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/characters.ts backend/src/repo/__tests__/characters.test.ts
git commit -m "feat(myt-48): characters.listForCampaign"
```

---

## Task 7: `characters.findUserCharacterForCampaign` — TDD

**Files:**
- Modify: `backend/src/repo/__tests__/characters.test.ts`
- Modify: `backend/src/repo/characters.ts`

- [ ] **Step 1: Add the two failing tests**

Append a new `describe('findUserCharacterForCampaign', ...)` block:

```ts
  describe('findUserCharacterForCampaign', () => {
    it('returns the user\'s character when one is joined to the campaign', async () => {
      const characters = createCharactersRepo(pool)
      const client = await pool.connect()
      let charId: string
      try {
        await client.query('BEGIN')
        const created = await characters.create(client, { userId, ...baseCharacterInput })
        await client.query('COMMIT')
        charId = created.id
      } finally {
        client.release()
      }

      await characters.addToCampaign(_campaignId, charId, userId)

      const found = await characters.findUserCharacterForCampaign(userId, _campaignId)
      expect(found?.id).toBe(charId)
      expect(found?.userId).toBe(userId)
    })

    it('returns null when the user has no character in the campaign', async () => {
      const characters = createCharactersRepo(pool)
      const found = await characters.findUserCharacterForCampaign(userId, _campaignId)
      expect(found).toBeNull()
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test -- characters.test.ts`

Expected: 2 new tests fail because `findUserCharacterForCampaign` is not a function.

- [ ] **Step 3: Implement `findUserCharacterForCampaign`**

In `backend/src/repo/characters.ts`, add the method after `listForCampaign`:

```ts
    findUserCharacterForCampaign: async (
      userId: string,
      campaignId: string,
    ): Promise<Character | null> => {
      const result = await pool.query<CharacterDbRow>(
        `SELECT c.*
         FROM characters c
         JOIN campaign_characters cc ON cc.character_id = c.id
         WHERE cc.campaign_id = $1 AND cc.user_id = $2
         LIMIT 1`,
        [campaignId, userId],
      )
      const row = result.rows[0]
      return row ? toCharacter(row) : null
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test -- characters.test.ts`

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/characters.ts backend/src/repo/__tests__/characters.test.ts
git commit -m "feat(myt-48): characters.findUserCharacterForCampaign"
```

---

## Task 8: Register `characters` namespace in `repo/index.ts`

**Files:**
- Modify: `backend/src/repo/index.ts`

- [ ] **Step 1: Add the import + factory call**

In `backend/src/repo/index.ts`, add the import after the existing `createInvitesRepo` import:

```ts
import { createCharactersRepo } from './characters.js'
```

And add `characters: createCharactersRepo(pool),` to the object returned by `createRepo`. The full function should read:

```ts
export function createRepo(pool: Pool) {
  return {
    users: createUsersRepo(pool),
    worlds: createWorldsRepo(pool),
    campaigns: createCampaignsRepo(pool),
    sessions: createSessionsRepo(pool),
    credits: createCreditsRepo(pool),
    invites: createInvitesRepo(pool),
    characters: createCharactersRepo(pool),
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter backend typecheck`

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add backend/src/repo/index.ts
git commit -m "feat(myt-48): register characters in repo namespace registry"
```

---

## Task 9: Full verification

- [ ] **Step 1: Run typecheck**

Run: `pnpm --filter backend typecheck`

Expected: exit 0.

- [ ] **Step 2: Run lint**

Run: `pnpm --filter backend lint`

Expected: exit 0. If any unused-import warnings in `characters.ts` from earlier task notes, remove them now (e.g., if `CampaignCharacter` or `toCampaignCharacter` ended up unused, drop the import).

- [ ] **Step 3: Run the full backend test suite**

Run: `pnpm --filter backend test`

Expected: all tests pass, including the 8 new `characters.test.ts` cases.

- [ ] **Step 4: Run dev-tool:check**

Run: `pnpm dev-tool:check`

Expected: exit 0 (no contract changes, manifest unchanged).

- [ ] **Step 5: If anything failed, fix and re-run; otherwise no commit needed**

The verification step only commits if there were lint fixes. Otherwise advance to Task 10.

---

## Task 10: Wiki update

**Files:**
- Modify: `docs/wiki/content/data/schema.html`

- [ ] **Step 1: Read the existing schema page to find the characters section**

Open `docs/wiki/content/data/schema.html`. Find the section describing `characters` (around line 227 per the design-doc audit) and the section listing indexes (around line 546).

- [ ] **Step 2: Update the characters prose**

The characters section likely says something like "characters are the player avatars: stats, hit points, level, class…". Update it to reflect the new shape — characters are user-owned, with a separate `campaign_characters` join table linking them to campaigns. Add a short paragraph describing why: future portability (one character → multiple campaigns) without a follow-up migration; launch-day behavior is gated by `UNIQUE (campaign_id, user_id)` on the join.

Aim for 2–3 paragraphs total in the characters block. Concise. Match the existing prose register.

- [ ] **Step 3: Update the index list**

Find the line mentioning `idx_characters_campaign` (around line 546). Replace `idx_characters_campaign` with `idx_campaign_characters_user` and `idx_campaign_characters_character` (or restructure the bullet to match the existing list style).

- [ ] **Step 4: Refresh wiki source hashes if the page has frontmatter declaring sources**

If `docs/wiki/content/data/schema.html` carries source-file hashes (the wiki-check convention), refresh them. The page's declared sources almost certainly include `backend/migrations/`; the new `009_character_portability.sql` should be added or the migration-glob hash refreshed.

Inspect the page header / `<meta>` tags. If unsure, run:

```bash
pnpm wiki:check
```

It will report any drift. If it flags missing source-hash for the new migration, follow the wiki authoring guide (`docs/wiki/AUTHORING.md`) to refresh.

- [ ] **Step 5: Verify wiki:check passes**

Run: `pnpm wiki:check`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add docs/wiki/content/data/schema.html
git commit -m "docs(wiki): schema page reflects characters portability (MYT-48)"
```

---

## Task 11: Final verification before merge

This is not a commit task — just the final sanity check before the worktree merges back to main.

- [ ] **Step 1: Run the full verification battery**

Run:
```bash
pnpm --filter backend typecheck
pnpm --filter backend lint
pnpm --filter backend test
pnpm wiki:check
pnpm dev-tool:check
```

Expected: all green.

- [ ] **Step 2: Confirm migration would apply cleanly on a fresh DB**

Run:
```bash
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
pnpm migrate:run
```

Expected: all 9 migrations apply cleanly, no assertion failures, exit 0.

- [ ] **Step 3: Confirm git log shows the expected commits**

Run: `git log --oneline main..HEAD`

Expected: ~9 commits on the `myt-48-migration` branch covering migration / types / errors / each repo method / registry / wiki.

- [ ] **Step 4: Hand off to the controller**

Do NOT push from inside the worktree. Per `CLAUDE.md` §"Parallel Implementation via Worktrees", the controller (the session that spawned this work) handles merge-to-main + push. Report DONE with a list of the commits on this branch.

---

## Notes for the executor

- All repo tests run against the shared dev Postgres reached via `DATABASE_URL`. The `guardTestDatabase` helper prevents accidental connection to a non-dev DB. The `beforeEach` `resetData(pool)` truncates all tables, so tests are isolated.
- `pg`'s error shape: `code: '23505'` is unique violation; `constraint` carries the constraint name. Postgres derives the default constraint name from `<table>_<col1>_<col2>_key` for composite UNIQUEs.
- The migration runner (per migration-runner spec) wraps each migration in a transaction automatically; the migration file itself does NOT need `BEGIN; ... COMMIT;`.
- `uuidv7()` is application-side via `repo/uuidv7.ts`.
- The `ClientLike` type lets `create` accept either a `Pool` or a `PoolClient` — used by the caller to compose `create` inside a wider transaction (MYT-53 will do this).
- Linter (`@typescript-eslint/no-unused-vars`) may flag imports referenced in later tasks but not the current step. Resolution: leave them in, the final lint pass in Task 9 will catch any genuinely-unused imports.
