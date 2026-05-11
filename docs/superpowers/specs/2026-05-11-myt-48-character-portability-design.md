# MYT-48 — Character Portability (Migration 009)

**Status:** Design approved 2026-05-11. Implementation next.
**Parent spec:** `docs/specs/2026-04-13-world-campaign-pipeline.md` §11.1
**Linear:** MYT-48
**Worktree:** `.worktrees/myt-48-migration`

## 1. Goal

Make characters user-owned with a campaign-membership join table so future cross-campaign character portability works without a follow-up migration. Day-one runtime behavior is unchanged (each character still belongs to exactly one campaign); only the schema shape changes.

The launch UX never lets a player attach the same character to two campaigns. The schema simply does not prevent that path.

## 2. Why this lands now

The amended prep-pipeline spec calls out portability as a day-one schema commitment. Landing it before the campaign-setup pipeline (MYT-53) means character creation can be authored against the final shape — no schema churn mid-milestone.

## 3. Scope

### 3.1 Migration `backend/migrations/009_character_portability.sql`

Single transaction, four DDL ops, one assertion block at the end. Matches the conventions in migrations 005 / 007 / 008 (schema-scoped to `current_schema()`, not hard-coded `'public'`).

DDL:

```sql
-- characters: drop campaign_id, make user_id mandatory
ALTER TABLE characters ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE characters DROP CONSTRAINT characters_campaign_id_fkey;
ALTER TABLE characters DROP COLUMN campaign_id;

-- campaign_characters: new join table
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
```

The `UNIQUE (campaign_id, user_id)` enforces the day-one rule of "one character per user per campaign." When portability ships, this constraint stays — porting means joining the *same* `character_id` to a different `campaign_id`, not adding a second character for one user in one campaign.

Assertion block validates: `campaign_id` column removed from `characters`, `user_id` is NOT NULL, table `campaign_characters` exists, both unique indexes exist. Schema-scoped per the prior migration conventions.

Greenfield: `characters` is empty in dev / staging. No data migration. No backfill. No DEFAULT-then-NOT-NULL dance.

### 3.2 Repository layer

`backend/src/repo/characters.ts` — new namespace factory `createCharactersRepo(pool)`. Methods:

| Method | Shape | Purpose |
|---|---|---|
| `create(client, input)` | `(client: PoolClient, input: CreateCharacterInput) => Promise<Character>` | Creates the user-owned character row. Takes a `PoolClient` so the caller controls the transaction (matches `users.create` from MYT-38). |
| `listForCampaign(campaignId)` | `(campaignId: string) => Promise<readonly Character[]>` | Joins `campaign_characters` → `characters`. |
| `addToCampaign(campaignId, characterId, userId)` | `(campaignId: string, characterId: string, userId: string) => Promise<void>` | Inserts the join row. Throws typed `CharacterAlreadyInCampaignError` on `(campaign_id, character_id)` violation, `UserAlreadyHasCharacterInCampaignError` on `(campaign_id, user_id)` violation. |
| `findUserCharacterForCampaign(userId, campaignId)` | `(userId: string, campaignId: string) => Promise<Character \| null>` | Used by route handlers to look up "what character does this player have in this campaign?" |

`CreateCharacterInput` covers the portable shape: `userId`, `name`, `level`, `class`, `species`, `background`, ability scores (`str`/`dex`/`con`/`int`/`wis`/`cha`), `hitPoints`, `maxHitPoints`, `armorClass`, `proficiencyBonus`. No `campaignId` — character creation and campaign membership are two separate inserts, both expected to happen in the same transaction at the MYT-53 call site.

Typed errors live in `backend/src/repo/characters-errors.ts` (matches `invites-errors.ts` / `credits-errors.ts` pattern).

### 3.3 Types + mappers

`backend/src/repo/types.ts`:
- `Character` (camelCase TS surface).
- `CampaignCharacter` (camelCase TS surface for the join row).
- `CreateCharacterInput`.

`backend/src/repo/mappers.ts`:
- `CharacterDbRow` + `toCharacter`.
- `CampaignCharacterDbRow` + `toCampaignCharacter`.

### 3.4 Registry

`backend/src/repo/index.ts` — append `characters: createCharactersRepo(pool)` to the `createRepo` factory.

### 3.5 Test data reset

`backend/src/repo/__tests__/_helpers/reset-data.ts` — append `'campaign_characters'` to the TRUNCATE list under the "Campaigns + characters" section. `TRUNCATE ... CASCADE` handles FK ordering so position doesn't matter; placement is for readability.

### 3.6 Tests

`backend/src/repo/__tests__/characters.test.ts` — integration tests against the dev Postgres (matches `campaigns.test.ts` / `invites.test.ts` pattern).

Coverage:

- `create` returns a row with the portable shape.
- `addToCampaign` succeeds first time.
- `addToCampaign` throws `CharacterAlreadyInCampaignError` on the same `(campaign_id, character_id)`.
- `addToCampaign` throws `UserAlreadyHasCharacterInCampaignError` on a different `character_id` with the same `(campaign_id, user_id)`.
- `listForCampaign` returns the joined characters in the right order.
- `listForCampaign` returns `[]` for a campaign with no characters.
- `findUserCharacterForCampaign` returns the matching character or `null`.

## 4. Out of scope

- Anything that consumes the new shape — character routes, character creation pipeline stages, the `character_concept` / `character_sheet` / `character_integration` workers — all land in MYT-53.
- Marketplace / public character browsing.
- Multi-character-per-user-per-campaign (still gated by the `UNIQUE (campaign_id, user_id)` constraint).
- Backfill / data migration (greenfield, table is empty).

## 5. Ship-gate impact

None. This issue adds:
- 0 entries to `backend/src/contract/pipeline-routes.ts`
- 0 entries to `backend/src/contract/pipeline-events.ts`
- 0 entries to `backend/src/contract/pipeline-jobs.ts`

The new repo namespace is consumed by future issues; it's not user-observable on its own. `pnpm dev-tool:check` stays green with no manifest changes.

## 6. Done when

- `pnpm migrate:run` applies 009 cleanly against the dev Postgres.
- Manual verification: same migration applies cleanly against a fresh staging Postgres (will run via the existing `db-migrate` workflow after merge).
- `repo/__tests__/characters.test.ts` covers the seven test cases above, all passing.
- `pnpm typecheck && pnpm lint && pnpm test` green.
- `pnpm wiki:check` green (wiki update lands in the same PR — brief addition to the schema page).
- Linear MYT-48 → Done after merge from worktree and final push.

## 7. Estimate

Half a day per the milestone estimate. Small, well-scoped, no novel decisions.
