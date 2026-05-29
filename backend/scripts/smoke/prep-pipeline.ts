// backend/scripts/smoke/prep-pipeline.ts
//
// MYT-55 — end-to-end staging smoke for the prep pipeline.
//
// Drives 3 concurrent campaigns × 3 players each against the deployed
// staging API. Saturates worker concurrency caps (3 world-gen + 5
// campaign-setup = 8 in-flight Anthropic streams at peak). Verifies the
// three-layer assertion contract from the spec §3.4:
//   A. Phase completeness (campaigns active, worlds complete, all
//      pipeline_runs completed, characters present).
//   B. Per-concept floors (entity / relationship / fact counts).
//   C. Global gates (cost cap, wall-clock budget, zero 429s).
//
// On PASS: cascade-deletes everything created during the run.
// On FAIL: leaves state intact, prints IDs + the failed assertion, exits 1.
//
// Pattern reference: backend/scripts/smoke/entity-consolidation-flow.ts.
//
// Runs in-VPC as the `mythrun-staging-smoke-prep-pipeline` ECS task (T7').
// DB connectivity is established by composing DATABASE_URL at runtime from
// DB_HOST/DB_PORT/DB_USER/DB_NAME (plain text) + DB_PASSWORD (Secrets
// Manager via task-def secrets[].valueFrom). There is intentionally no
// shared DATABASE_URL secret — the task brings its own DB credential
// surface in line with the worker / API task definitions.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider'
import { type Pool } from 'pg'
import { createHash } from 'node:crypto'
import { createPgPool } from '../../src/db/postgres.js'
import { entities } from '../../src/repo/entities.js'
import { relationships } from '../../src/repo/relationships.js'
import { facts } from '../../src/repo/facts.js'

// ---------------------------------------------------------------------------
// Config — env-driven, no defaults that point at production
// ---------------------------------------------------------------------------

interface SmokeConfig {
  readonly awsRegion: string
  readonly cognitoUserPoolId: string
  readonly cognitoClientId: string
  readonly apiBase: string
  readonly ownerSecretId: string
  readonly playerSecretIds: readonly [string, string, string]
  readonly wallClockBudgetMs: number
  readonly costCapUsd: number
}

function requireEnv(key: string): string {
  const v = process.env[key]
  if (v === undefined || v === '') {
    log('error', 'config_missing', { missing: [key] })
    process.exit(2)
  }
  return v
}

function loadConfig(): SmokeConfig {
  // Validate all required env vars up front (single missing-list log line
  // rather than failing on the first one accessed).
  const required = [
    'AWS_REGION',
    'COGNITO_USER_POOL_ID',
    'COGNITO_CLIENT_ID',
    'API_BASE',
    'SMOKE_OWNER_SECRET_ID',
    'SMOKE_PLAYER_1_SECRET_ID',
    'SMOKE_PLAYER_2_SECRET_ID',
    'SMOKE_PLAYER_3_SECRET_ID',
    'SMOKE_WALL_CLOCK_BUDGET_MS',
    'SMOKE_COST_CAP_USD',
  ]
  const missing = required.filter((k) => {
    const v = process.env[k]
    return v === undefined || v === ''
  })
  if (missing.length > 0) {
    log('error', 'config_missing', { missing })
    process.exit(2)
  }
  return {
    awsRegion: requireEnv('AWS_REGION'),
    cognitoUserPoolId: requireEnv('COGNITO_USER_POOL_ID'),
    cognitoClientId: requireEnv('COGNITO_CLIENT_ID'),
    apiBase: requireEnv('API_BASE').replace(/\/$/, ''),
    ownerSecretId: requireEnv('SMOKE_OWNER_SECRET_ID'),
    playerSecretIds: [
      requireEnv('SMOKE_PLAYER_1_SECRET_ID'),
      requireEnv('SMOKE_PLAYER_2_SECRET_ID'),
      requireEnv('SMOKE_PLAYER_3_SECRET_ID'),
    ] as const,
    wallClockBudgetMs: Number(requireEnv('SMOKE_WALL_CLOCK_BUDGET_MS')),
    costCapUsd: Number(requireEnv('SMOKE_COST_CAP_USD')),
  }
}

// ---------------------------------------------------------------------------
// Structured log — one JSON line per event to stdout
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', event: string, payload: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...payload }) + '\n',
  )
}

// ---------------------------------------------------------------------------
// DB URL composition — refuses anything that doesn't look like staging
// ---------------------------------------------------------------------------

function loadDbUrl(): string {
  const host = requireEnv('DB_HOST')
  const port = requireEnv('DB_PORT')
  const user = requireEnv('DB_USER')
  const password = requireEnv('DB_PASSWORD')
  const name = requireEnv('DB_NAME')
  // Belt-and-suspenders: refuse if DB_NAME doesn't include 'staging'. The
  // staging RDS hostname is environment-anonymized (`mythrun.<id>.rds...`),
  // but the database name is `mythrun_staging`. Catches the hypothetical
  // reconfiguration that points at prod (db name `mythrun_prod`).
  if (!name.includes('staging')) {
    log('error', 'db_name_sanity_failed', { name })
    throw new Error(`DB_NAME '${name}' does not contain 'staging' — refusing to proceed`)
  }
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}?sslmode=require`
}

// ---------------------------------------------------------------------------
// Cognito auth — fetch creds from Secrets Manager, exchange for access token
// ---------------------------------------------------------------------------

interface CognitoCreds {
  readonly username: string
  readonly password: string
}

interface AuthedUser {
  readonly secretId: string
  readonly username: string
  readonly accessToken: string
}

async function fetchCreds(sm: SecretsManagerClient, secretId: string): Promise<CognitoCreds> {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }))
  if (!res.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString`)
  }
  const parsed = JSON.parse(res.SecretString) as { username: string; password: string }
  return { username: parsed.username, password: parsed.password }
}

async function authUser(
  cog: CognitoIdentityProviderClient,
  cfg: SmokeConfig,
  creds: CognitoCreds,
): Promise<string> {
  const res = await cog.send(new InitiateAuthCommand({
    ClientId: cfg.cognitoClientId,
    AuthFlow: 'USER_AUTH',
    AuthParameters: {
      USERNAME: creds.username,
      PASSWORD: creds.password,
      PREFERRED_CHALLENGE: 'PASSWORD',
    },
  }))
  const token = res.AuthenticationResult?.AccessToken
  if (!token) {
    throw new Error(`Auth for ${creds.username} returned no AccessToken (challenge: ${res.ChallengeName ?? 'none'})`)
  }
  return token
}

async function authAll(cfg: SmokeConfig): Promise<{ owner: AuthedUser; players: readonly [AuthedUser, AuthedUser, AuthedUser] }> {
  const sm = new SecretsManagerClient({ region: cfg.awsRegion })
  const cog = new CognitoIdentityProviderClient({ region: cfg.awsRegion })
  log('info', 'auth_started', { region: cfg.awsRegion })
  const all = await Promise.all(
    [cfg.ownerSecretId, ...cfg.playerSecretIds].map(async (secretId) => {
      const creds = await fetchCreds(sm, secretId)
      const accessToken = await authUser(cog, cfg, creds)
      log('info', 'authed', { secretId, username: creds.username })
      return { secretId, username: creds.username, accessToken }
    }),
  )
  const [owner, p1, p2, p3] = all
  if (!owner || !p1 || !p2 || !p3) throw new Error('authAll: expected 4 users')
  return { owner, players: [p1, p2, p3] as const }
}

// ---------------------------------------------------------------------------
// Hand-curated concepts + calibrated assertion floors
// ---------------------------------------------------------------------------

interface AssertionFloors {
  readonly minEntities: number
  readonly minRelationships: number
  /** Average facts per entity (total facts ÷ total entities). */
  readonly minFactsPerEntity: number
}

interface Concept {
  readonly name: string
  readonly concept: string
  readonly floors: AssertionFloors
}

// Floors calibrated at ~60% of the values observed during myth-imxg's
// coherence smoke (Bardsmoot world: 43 entities, 55 relationships, 124
// facts → 2.9 facts/entity). Conservative enough to absorb LLM variance;
// tight enough to catch a silently-degenerate stage.
export const CONCEPTS: readonly Concept[] = [
  {
    name: 'bardsmoot',
    concept:
      'A market town nestled in a low river valley, ruled not by lord or council but by the Bardsmoot — an annual conclave of traveling musicians whose songs adjudicate disputes, set tax rates, and decide which roads get repaired. The town prospers because its merchant guilds long ago figured out that whoever pays the most popular bard always wins their case, while the bards themselves split their year between performing here and elsewhere, carrying news, rumor, and political pressure along the trade routes. Lately the songs have been turning darker.',
    floors: { minEntities: 25, minRelationships: 15, minFactsPerEntity: 1.5 },
  },
  {
    name: 'haunted-carnival',
    concept:
      'A traveling seasonal carnival that has visited the same crossroad-town every autumn for as long as anyone alive remembers. It always arrives on the third night after the first frost and is gone by morning of the seventh day. Locals love it, plan their year around it, marry under its lanterns. They also know — though they do not speak of it — that the carnival exacts a quiet, specific cost from one family every visit, and the families it has touched can be traced back generations in the parish ledger. This year the frost came early.',
    floors: { minEntities: 25, minRelationships: 15, minFactsPerEntity: 1.5 },
  },
  {
    name: 'mountain-monastery',
    concept:
      'A high-altitude monastic order that sustains itself by tending an enormous, centuries-old library carved directly into the rock face. The monks are scholars, copyists, and silent appraisers of texts pilgrims bring up the long stone stair for safekeeping. The monastery has no formal hierarchy — order emerges from who sits next to whom at the long refectory tables, which is decided each season by the librarian-in-chief through a process nobody outside the order fully understands. A delegation from the lowland court has just arrived demanding access to a specific shelf.',
    floors: { minEntities: 25, minRelationships: 15, minFactsPerEntity: 1.5 },
  },
] as const

// ---------------------------------------------------------------------------
// API client + small fetch helpers
// ---------------------------------------------------------------------------

interface ApiClient {
  readonly token: string
  readonly base: string
}

async function apiPost<T>(client: ApiClient, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${client.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${client.token}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`POST ${path} → ${String(res.status)}: ${text}`)
  }
  return JSON.parse(text) as T
}

async function apiGet<T>(client: ApiClient, path: string): Promise<T> {
  const res = await fetch(`${client.base}${path}`, {
    headers: { authorization: `Bearer ${client.token}` },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`GET ${path} → ${String(res.status)}: ${text}`)
  }
  return JSON.parse(text) as T
}

async function pollFor<T>(
  fetcher: () => Promise<T>,
  predicate: (val: T) => boolean,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  let lastVal: T | undefined
  while (Date.now() < deadline) {
    const val = await fetcher()
    lastVal = val
    if (predicate(val)) return val
    await new Promise((r) => setTimeout(r, opts.intervalMs))
  }
  throw new Error(
    `poll timeout: ${opts.label} after ${String(opts.timeoutMs)}ms; lastVal=${JSON.stringify(lastVal)}`,
  )
}

// ---------------------------------------------------------------------------
// User materialization
//
// The users table row is created by POST /api/users/register, NOT by any
// GET path (GET /api/users/me 403s with username_required until register
// has run). The smoke users are pre-baked Cognito identities; on the first
// run we register them, on every subsequent run the route short-circuits
// to the 200 idempotent "already onboarded same sub" path. Either is fine.
// ---------------------------------------------------------------------------

function deriveUsernameFromCognito(cognitoUsername: string): string {
  // Hash-based so emails sharing a long prefix (e.g.,
  // mythrun-staging-smoke-{owner,player-1,player-2,player-3}@example.com)
  // collapse to the same alphanumeric prefix when truncated. SHA-256 hex
  // gives [0-9a-f] which fits the register-route regex
  // /^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/ (3..20 chars). Prefix
  // with `s` (smoke) so a leading digit can't break the first-char anchor.
  const hash = createHash('sha256').update(cognitoUsername).digest('hex')
  return `s${hash.slice(0, 19)}`
}

async function materializeUserRows(cfg: SmokeConfig, users: readonly AuthedUser[]): Promise<void> {
  // Run sequentially rather than Promise.all'd — POST /api/users/register
  // is rate-limited 5/min per-sub which is fine for 4 users, but the
  // serial loop also keeps the per-user logs interleaved cleanly with the
  // /me follow-up. Idempotent by design: 200 on already-registered.
  for (const u of users) {
    const username = deriveUsernameFromCognito(u.username)
    const res = await fetch(`${cfg.apiBase}/api/users/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${u.accessToken}`,
      },
      body: JSON.stringify({ username, displayName: `Smoke ${username}` }),
    })
    const body = await res.text()
    // 201 = first-time register, 200 = idempotent already-onboarded-same,
    // 409 already_onboarded with a different username from a previous run
    //     with a different derived name (also fine — the row exists).
    if (res.status !== 201 && res.status !== 200 && res.status !== 409) {
      throw new Error(`materializeUserRows: ${u.username} got ${String(res.status)}: ${body}`)
    }
    log('info', 'user_materialized', { username: u.username, derived: username, status: res.status })
  }
}

// ---------------------------------------------------------------------------
// Campaign driver — owner creates, players join + submit concepts, poll
// ---------------------------------------------------------------------------

interface CampaignRunResult {
  readonly conceptName: string
  readonly campaignId: string
  readonly worldId: string
  readonly worldStatus: string
  readonly campaignStatus: string
  readonly costUsd: number
  readonly entityCount: number
  readonly relationshipCount: number
  readonly factCount: number
  readonly characterIds: readonly string[]
  readonly durationMs: number
}

async function runOneCampaign(
  cfg: SmokeConfig,
  allUsers: readonly [AuthedUser, AuthedUser, AuthedUser, AuthedUser],
  ownerIndex: 0 | 1 | 2,
  concept: Concept,
  pool: Pool,
): Promise<CampaignRunResult> {
  // Round-robin owners across the 3 campaigns so the per-`created_by`
  // 409 concurrent_generation_in_progress guard never fires — each
  // campaign is owned by a distinct user, and the remaining 3 users are
  // the players. This is what lets the 3 world-gens run in genuine
  // parallel (saturating the worker concurrency caps, which is the
  // half of the smoke that verifies the rate-limit posture).
  const owner = allUsers[ownerIndex]
  const players = allUsers.filter((_, i) => i !== ownerIndex) as unknown as readonly [
    AuthedUser,
    AuthedUser,
    AuthedUser,
  ]
  const ownerApi: ApiClient = { token: owner.accessToken, base: cfg.apiBase }
  const startMs = Date.now()
  log('info', 'campaign_started', { concept: concept.name, owner: owner.username })

  // 1. Owner creates the campaign. With distinct owners across the 3
  //    concurrent runs, the per-`created_by` concurrent-generation guard
  //    doesn't fire — direct apiPost, no backoff.
  const created = await apiPost<{ campaignId: string }>(ownerApi, '/api/campaigns', {
    world: { kind: 'new' as const, source: { mode: 'freeform' as const, concept: concept.concept } },
  })
  const campaignId = created.campaignId
  log('info', 'campaign_created', { concept: concept.name, campaignId })

  // 2. Wait for world-gen to reach world.status='complete'. Budget is
  // generous — observed stage timings against real Opus:
  // world_and_factions ~150s, locations_and_npcs ~235s, entity_relationships
  // ~180s, others 30-90s each. 7 stages + repair-chain headroom = ~20min
  // worst case per world; pad to 25.
  const polled = await pollFor(
    () => apiGet<{ world: { id: string; status: string } }>(ownerApi, `/api/campaigns/${campaignId}`),
    (val) => val.world.status === 'complete' || val.world.status === 'failed',
    { timeoutMs: 25 * 60_000, intervalMs: 10_000, label: `world-gen for ${concept.name}` },
  )
  if (polled.world.status !== 'complete') {
    throw new Error(`campaign ${campaignId} world status = ${polled.world.status}`)
  }
  const worldId = polled.world.id
  log('info', 'world_complete', { concept: concept.name, campaignId, worldId })

  // 3. Each player joins via invite (owner mints one invite per player).
  //    The invite create body is empty (server fills in defaults).
  await Promise.all(players.map(async (player) => {
    const playerApi: ApiClient = { token: player.accessToken, base: cfg.apiBase }
    const invite = await apiPost<{ inviteCode: string }>(
      ownerApi,
      `/api/campaigns/${campaignId}/invites`,
      {},
    )
    await apiPost(playerApi, `/api/invites/${invite.inviteCode}/accept`, {})
    log('info', 'player_joined', { concept: concept.name, campaignId, player: player.username })
  }))

  // 4. Owner picks a starting situation (T15 character submit 409s
  //    starting_situation_not_chosen until this runs). Index 0 is fine.
  await apiPost(ownerApi, `/api/campaigns/${campaignId}/starting-situation`, { index: 0 })
  log('info', 'starting_situation_chosen', { concept: concept.name, campaignId, index: 0 })

  // 5. Every member — owner + 3 players — submits a character concept.
  //    The owner is a campaign member too: campaigns have 4 members
  //    after invites land, and the character-creation-progress endpoint
  //    reports `missing` for any member who hasn't submitted (MYT-53).
  //    The smoke initially iterated `players` only (3 submissions), which
  //    left the owner in `missing` and the poll timed out. Submit for
  //    all 4 members.
  //
  //    The MYT-53 route is submit + flip + enqueue in one transaction —
  //    the 200 response implies the per-player BullMQ job is on the queue.
  //
  //    conceptText / situationGroundingText both have a 20-char minimum
  //    (Zod + DB CHECK constraint). The strings here are smoke-test
  //    plausible (not eval-quality), well past the 20-char floor.
  const allMembers: readonly AuthedUser[] = [owner, ...players]
  await Promise.all(allMembers.map(async (member, i) => {
    const memberApi: ApiClient = { token: member.accessToken, base: cfg.apiBase }
    await apiPost(memberApi, `/api/campaigns/${campaignId}/characters`, {
      conceptText: `A traveling stranger drawn into the ${concept.name} world by a personal debt they cannot yet name. Member ${String(i + 1)}'s arc.`,
      situationGroundingText: `Arrived at the starting situation looking for work, a meal, and somewhere quiet to sleep. Member ${String(i + 1)}.`,
    })
    log('info', 'member_concept_submitted', {
      concept: concept.name,
      campaignId,
      memberIndex: i,
      role: i === 0 ? 'owner' : 'player',
    })
  }))

  // 6. Wait for ALL 4 character concepts to reach status='completed'.
  //    The character-creation-progress endpoint enumerates each member's
  //    concept status; we wait until every one is terminal.
  await pollFor(
    () => apiGet<{
      totalMembers: number
      concepts: readonly { status: string }[]
      missing: readonly unknown[]
    }>(ownerApi, `/api/campaigns/${campaignId}/character-creation-progress`),
    (val) => val.missing.length === 0 && val.concepts.length === 4 &&
      val.concepts.every((c) => c.status === 'completed' || c.status === 'failed'),
    { timeoutMs: 15 * 60_000, intervalMs: 10_000, label: `character-creation for ${concept.name}` },
  )

  // 7. Owner triggers finalize (integration + flip to active).
  await apiPost(ownerApi, `/api/campaigns/${campaignId}/finalize-character-creation`, {})
  log('info', 'finalize_triggered', { concept: concept.name, campaignId })

  // 8. Wait for campaign.status='active' (post-integration barrier) or
  //    'failed' (MYT-56: terminal integration failure flips status to
  //    'failed' so clients can distinguish "still running" from "stuck").
  const finalState = await pollFor(
    () => apiGet<{ campaign: { status: string } }>(ownerApi, `/api/campaigns/${campaignId}`),
    (val) => val.campaign.status === 'active' || val.campaign.status === 'failed',
    { timeoutMs: 10 * 60_000, intervalMs: 10_000, label: `campaign active for ${concept.name}` },
  )
  if (finalState.campaign.status !== 'active') {
    throw new Error(`campaign ${campaignId} final status = ${finalState.campaign.status}`)
  }
  log('info', 'campaign_active', { concept: concept.name, campaignId })

  // 9. Read final state from DB (counts + cost) via repo modules.
  const stats = await readCampaignStats(pool, worldId, campaignId)

  return {
    conceptName: concept.name,
    campaignId,
    worldId,
    worldStatus: 'complete',
    campaignStatus: 'active',
    costUsd: stats.costUsd,
    entityCount: stats.entityCount,
    relationshipCount: stats.relationshipCount,
    factCount: stats.factCount,
    characterIds: stats.characterIds,
    durationMs: Date.now() - startMs,
  }
}

interface CampaignStats {
  readonly costUsd: number
  readonly entityCount: number
  readonly relationshipCount: number
  readonly factCount: number
  readonly characterIds: readonly string[]
}

async function readCampaignStats(pool: Pool, worldId: string, campaignId: string): Promise<CampaignStats> {
  const client = await pool.connect()
  try {
    const ents = await entities.listByWorld(client, worldId)
    const rels = await relationships.listByWorld(client, worldId)
    // facts.listByEntities requires an explicit accessLevels filter. The
    // assertion floors are computed against ALL tiers (known + discoverable
    // + secret); the snapshot view's tier-gated read happens elsewhere.
    const factRows = await facts.listByEntities(
      client,
      ents.map((e) => e.id),
      { accessLevels: ['known', 'discoverable', 'secret'] },
    )
    const [charRes, costRes] = await Promise.all([
      // campaign_characters is the user→character join (MYT-48); list its
      // character_id column for the campaign so we know what to delete.
      client.query<{ character_id: string }>(
        `SELECT character_id FROM campaign_characters WHERE campaign_id = $1`,
        [campaignId],
      ),
      // pipeline_runs straddles both surfaces — world-gen runs carry
      // world_id, character-creation/integration runs carry campaign_id.
      // Sum both branches to get the campaign's true total cost.
      client.query<{ total: string }>(
        `SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM pipeline_runs
          WHERE world_id = $1 OR campaign_id = $2`,
        [worldId, campaignId],
      ),
    ])
    return {
      costUsd: Number(costRes.rows[0]?.total ?? 0),
      entityCount: ents.length,
      relationshipCount: rels.length,
      factCount: factRows.length,
      characterIds: charRes.rows.map((r) => r.character_id),
    }
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// Assertion contract — three layers per spec §3.4
// ---------------------------------------------------------------------------

interface AssertionFailure {
  readonly layer: 'A' | 'B' | 'C'
  readonly detail: string
}

async function assertContract(
  results: readonly CampaignRunResult[],
  cfg: SmokeConfig,
  pool: Pool,
): Promise<readonly AssertionFailure[]> {
  const fails: AssertionFailure[] = []

  // Layer A — phase completeness
  for (const r of results) {
    if (r.worldStatus !== 'complete') {
      fails.push({ layer: 'A', detail: `${r.conceptName}: world status = ${r.worldStatus}` })
    }
    if (r.campaignStatus !== 'active') {
      fails.push({ layer: 'A', detail: `${r.conceptName}: campaign status = ${r.campaignStatus}` })
    }
    if (r.characterIds.length !== 3) {
      fails.push({ layer: 'A', detail: `${r.conceptName}: character count = ${String(r.characterIds.length)}, expected 3` })
    }
  }

  // Layer A — pipeline_runs completeness. A non-completed row (failed or
  // stuck pending) is a tier-A failure regardless of whether the higher-
  // level barriers (world.status, campaign.status) hit their targets.
  const worldIds = results.map((r) => r.worldId)
  const campaignIds = results.map((r) => r.campaignId)
  if (worldIds.length > 0) {
    const prRes = await pool.query<{ stage: string; status: string; world_id: string | null; campaign_id: string | null }>(
      `SELECT stage, status, world_id, campaign_id FROM pipeline_runs
        WHERE (world_id = ANY($1) OR campaign_id = ANY($2)) AND status != 'completed'`,
      [worldIds, campaignIds],
    )
    for (const row of prRes.rows) {
      fails.push({
        layer: 'A',
        detail: `pipeline_runs stage=${row.stage} status=${row.status} world_id=${row.world_id ?? 'null'} campaign_id=${row.campaign_id ?? 'null'}`,
      })
    }
  }

  // Layer B — per-concept floors
  for (const r of results) {
    const concept = CONCEPTS.find((c) => c.name === r.conceptName)
    if (!concept) {
      fails.push({ layer: 'B', detail: `unknown concept ${r.conceptName}` })
      continue
    }
    if (r.entityCount < concept.floors.minEntities) {
      fails.push({
        layer: 'B',
        detail: `${r.conceptName}: entities ${String(r.entityCount)} < floor ${String(concept.floors.minEntities)}`,
      })
    }
    if (r.relationshipCount < concept.floors.minRelationships) {
      fails.push({
        layer: 'B',
        detail: `${r.conceptName}: relationships ${String(r.relationshipCount)} < floor ${String(concept.floors.minRelationships)}`,
      })
    }
    const factsPerEntity = r.entityCount > 0 ? r.factCount / r.entityCount : 0
    if (factsPerEntity < concept.floors.minFactsPerEntity) {
      fails.push({
        layer: 'B',
        detail: `${r.conceptName}: facts/entity ${factsPerEntity.toFixed(2)} < floor ${String(concept.floors.minFactsPerEntity)}`,
      })
    }
  }

  // Layer C — global cost cap.
  const totalCost = results.reduce((sum, r) => sum + r.costUsd, 0)
  if (totalCost > cfg.costCapUsd) {
    fails.push({
      layer: 'C',
      detail: `total cost $${totalCost.toFixed(2)} > cap $${cfg.costCapUsd.toFixed(2)}`,
    })
  }

  // Layer C — zero 429s. Proxy: scan pipeline_runs.error for rate-limit
  // shape across both surfaces (world_id + campaign_id branches).
  if (worldIds.length > 0) {
    const rateLimitRes = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pipeline_runs
        WHERE (world_id = ANY($1) OR campaign_id = ANY($2))
          AND status = 'failed'
          AND (error ILIKE '%rate%limit%' OR error ILIKE '%429%')`,
      [worldIds, campaignIds],
    )
    const n = Number(rateLimitRes.rows[0]?.n ?? 0)
    if (n > 0) {
      fails.push({ layer: 'C', detail: `${String(n)} rate-limit errors observed in pipeline_runs` })
    }
  }

  return fails
}

// ---------------------------------------------------------------------------
// Teardown — cascade-delete campaigns + worlds + characters (PASS path only)
// ---------------------------------------------------------------------------

async function teardown(pool: Pool, results: readonly CampaignRunResult[]): Promise<void> {
  log('info', 'teardown_started', { campaignCount: results.length })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const campaignIds = results.map((r) => r.campaignId)
    const worldIds = results.map((r) => r.worldId)
    const characterIds = results.flatMap((r) => r.characterIds)

    // Most child tables cascade from worlds OR campaigns:
    //   - campaigns.world_id      ON DELETE CASCADE
    //   - campaign_members        ON DELETE CASCADE FROM campaigns
    //   - campaign_characters     ON DELETE CASCADE FROM campaigns
    //   - character_concepts      ON DELETE CASCADE FROM campaigns
    //   - entities                ON DELETE CASCADE FROM worlds
    //   - relationships           ON DELETE CASCADE FROM entities
    //   - facts                   ON DELETE CASCADE FROM entities
    //   - pipeline_runs           ON DELETE CASCADE FROM worlds AND campaigns
    //   - random_tables/entries   ON DELETE CASCADE FROM worlds
    //
    // characters is NOT cascade-deleted by either side (post-MYT-48 the
    // characters table is user-owned with no campaign FK), so we delete
    // the character rows BEFORE the campaign rows go — once campaign_
    // characters cascades away, the char-id list is the only handle.
    //
    // Order: characters first (FK constraints in character_skills etc.
    // cascade from characters.id), then worlds (cascades campaigns +
    // their descendants).
    if (characterIds.length > 0) {
      await client.query(`DELETE FROM characters WHERE id = ANY($1)`, [characterIds])
    }
    await client.query(`DELETE FROM worlds WHERE id = ANY($1)`, [worldIds])

    // Defense-in-depth: clean up any campaign-only pipeline_runs rows
    // whose worlds were already gone before this teardown (shouldn't
    // happen on PASS, but the explicit DELETE makes the intent grep-able).
    await client.query(`DELETE FROM pipeline_runs WHERE campaign_id = ANY($1)`, [campaignIds])

    await client.query('COMMIT')
    log('info', 'teardown_complete', {
      campaignCount: results.length,
      characterCount: characterIds.length,
    })
  } catch (err) {
    await client.query('ROLLBACK')
    // Teardown failure on PASS isn't fatal — log and move on. The smoke
    // still passed; manual cleanup is the recovery.
    log('warn', 'teardown_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// Pre-run state reset — clear any campaigns owned by smoke users
// ---------------------------------------------------------------------------

async function resetStaleCampaigns(
  cfg: SmokeConfig,
  pool: Pool,
  users: readonly AuthedUser[],
): Promise<void> {
  // Look up user_ids via /api/users/me — avoids hand-decoding JWTs to
  // get cognito_sub. Each authed user's GET /me returns its own row.
  const userIds = await Promise.all(
    users.map(async (u) => {
      const res = await fetch(`${cfg.apiBase}/api/users/me`, {
        headers: { Authorization: `Bearer ${u.accessToken}` },
      })
      if (!res.ok) {
        throw new Error(`resetStaleCampaigns: GET /me for ${u.username} returned ${String(res.status)}`)
      }
      const body = (await res.json()) as { user: { id: string } }
      return body.user.id
    }),
  )
  const client = await pool.connect()
  try {
    const inflight = await client.query<{ id: string; created_by: string; world_id: string }>(
      `SELECT id, created_by, world_id FROM campaigns WHERE created_by = ANY($1)`,
      [userIds],
    )
    if (inflight.rowCount === 0) {
      log('info', 'state_reset_noop', { reason: 'no smoke-user campaigns present' })
      return
    }
    const campaignIds = inflight.rows.map((r) => r.id)
    const worldIds = inflight.rows.map((r) => r.world_id)
    log('info', 'state_reset_starting', { campaignCount: inflight.rowCount, campaignIds })
    await client.query('BEGIN')
    await client.query(`DELETE FROM worlds WHERE id = ANY($1)`, [worldIds])
    await client.query(`DELETE FROM pipeline_runs WHERE campaign_id = ANY($1)`, [campaignIds])
    await client.query('COMMIT')
    log('info', 'state_reset_complete', { campaignCount: inflight.rowCount })
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig()
  const dbUrl = loadDbUrl() // throws on hostname sanity failure
  const startedAtMs = Date.now()
  log('info', 'phase', { phase: 'started', wallClockBudgetMs: cfg.wallClockBudgetMs, startedAtMs })

  const { owner, players } = await authAll(cfg)
  log('info', 'phase', { phase: 'authed', userCount: 1 + players.length })

  // Materialize user rows via /api/users/register. Idempotent — runs
  // through the 200 "already onboarded" branch on every run after the
  // first. Must happen before any /api/campaigns call (the create-
  // campaign txn needs the users.id to write the credit_ledger debit).
  await materializeUserRows(cfg, [owner, ...players])
  log('info', 'phase', { phase: 'users_materialized' })

  const pool = createPgPool(dbUrl, { max: 4 })

  // Reset state: delete any in-flight smoke-user-owned campaigns left
  // behind by a prior FAIL. Per-owner concurrency gate (returns 409
  // concurrent_generation_in_progress) blocks a new POST /api/campaigns
  // until the previous one completes — so without this, a single failed
  // smoke run blocks every subsequent one. Forensics live in CloudWatch
  // logs (full campaign IDs + diagnostics from the FAIL run); the DB
  // reflects the CURRENT run only.
  await resetStaleCampaigns(cfg, pool, [owner, ...players])
  log('info', 'phase', { phase: 'state_reset' })
  let pass = false
  let results: readonly CampaignRunResult[] = []

  try {
    // Round-robin ownership across the 4 Cognito users. Each concept
    // gets a distinct owner (indices 0/1/2 of allUsers); the remaining
    // 3 users are players for that campaign. The 4th user (index 3) is
    // always a player, never an owner — fine, the API doesn't care
    // about asymmetric participation. With 3 distinct creators the
    // per-`created_by` 409 guard never fires and the 3 world-gens run
    // in genuine parallel.
    const allUsers: readonly [AuthedUser, AuthedUser, AuthedUser, AuthedUser] = [
      owner,
      ...players,
    ] as const
    const campaignAssignments = CONCEPTS.map((concept, i) => ({
      concept,
      ownerIndex: i as 0 | 1 | 2, // CONCEPTS has exactly 3 entries
    }))
    results = await Promise.all(
      campaignAssignments.map(({ concept, ownerIndex }) =>
        runOneCampaign(cfg, allUsers, ownerIndex, concept, pool),
      ),
    )
    const wallClockMs = Date.now() - startedAtMs
    log('info', 'phase', { phase: 'burst_complete', campaigns: results.length, wallClockMs })

    const failures = await assertContract(results, cfg, pool)
    if (failures.length > 0) {
      for (const f of failures) log('error', 'assertion_failed', { layer: f.layer, detail: f.detail })
      log('error', 'summary', {
        verdict: 'FAIL',
        wallClockMs,
        failureCount: failures.length,
        campaigns: results,
      })
      process.exit(1)
    }
    if (wallClockMs > cfg.wallClockBudgetMs) {
      log('error', 'assertion_failed', {
        layer: 'C',
        detail: `wall-clock ${String(wallClockMs)}ms > budget ${String(cfg.wallClockBudgetMs)}ms`,
      })
      log('error', 'summary', { verdict: 'FAIL', wallClockMs, campaigns: results })
      process.exit(1)
    }
    log('info', 'summary', {
      verdict: 'PASS',
      wallClockMs,
      totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
      campaigns: results,
    })
    pass = true
  } finally {
    if (pass) {
      await teardown(pool, results)
    } else if (results.length > 0) {
      log('warn', 'leaving_state', {
        campaignIds: results.map((r) => r.campaignId),
        worldIds: results.map((r) => r.worldId),
        note: 'FAIL path — state preserved for inspection. Manual cleanup required.',
      })
    }
    await pool.end()
  }
}

main().catch((err: unknown) => {
  log('error', 'unhandled', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
