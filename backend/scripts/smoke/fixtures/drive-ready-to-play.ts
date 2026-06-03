// backend/scripts/smoke/fixtures/drive-ready-to-play.ts
//
// MYT-64 — (re)generate the ready-to-play-campaign smoke fixture by driving the REAL
// campaign pipeline to campaign.status='active' against a LOCAL bypass-auth backend
// (server on :3030 + worker on :3001, real Anthropic), then printing the campaignId.
//
// Usage (regeneration runbook):
//   1. pnpm db:migrate:test
//   2. boot server + worker with DATABASE_URL=$DATABASE_URL_TEST (mythrun_test) + a real
//      Anthropic key + Redis up.
//   3. tsx scripts/smoke/fixtures/drive-ready-to-play.ts   → prints CAMPAIGN_ID=<id>
//   4. DATABASE_URL=$DATABASE_URL_TEST pnpm capture:ready-to-play <id>
//   5. commit ready-to-play-campaign.json
//
// Single owner-member + 1 character = the minimum viable ready-to-play graph (a complete
// world + a chosen situation + one PC with an entity + known facts) — what
// serialize-world-state-for-prep reads. Pure HTTP (no DB access); the server owns the DB.
// NOT a test — a dev capture helper, run manually against real Anthropic.

const BASE = process.env.SMOKE_API_BASE ?? 'http://localhost:3030'
const SUB = process.env.SMOKE_DEV_SUB ?? 'dev-user-1'

function log(msg: string, extra?: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': SUB },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${String(res.status)}: ${text}`)
  return (text.length > 0 ? (JSON.parse(text) as T) : ({} as T))
}

async function pollFor<T>(
  fetcher: () => Promise<T>,
  ok: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await fetcher()
    if (ok(last)) return last
    await new Promise((r) => setTimeout(r, opts.intervalMs))
  }
  throw new Error(`poll timeout: ${opts.label}; last=${JSON.stringify(last)}`)
}

interface StatusResp {
  readonly campaign: { readonly status: string }
  readonly world: { readonly status: string }
}

async function main(): Promise<void> {
  // Resume support: real Opus world-gen takes ~20-25 min, so a run can be interrupted.
  // Set SMOKE_RESUME_CAMPAIGN=<id> to skip create+grant and pick up an in-progress campaign.
  const resumeId = process.env.SMOKE_RESUME_CAMPAIGN
  let campaignId: string
  if (resumeId !== undefined && resumeId !== '') {
    campaignId = resumeId
    log('resuming', { campaignId })
  } else {
    // 0. Grant the dev user credits (mythrun_test's seeded dev users have none; the
    //    create route gates on world_gen credit, character creation/integration on session).
    await api('POST', '/api/dev/credits/grant', { creditType: 'world_gen', amount: 5 })
    await api('POST', '/api/dev/credits/grant', { creditType: 'session', amount: 5 })
    log('credits_granted', {})

    const created = await api<{ campaignId: string }>('POST', '/api/campaigns', {
      world: {
        kind: 'new',
        source: {
          mode: 'freeform',
          concept:
            'A fog-wrapped harbor town where lamplighters trade in half-remembered names and the tide carries old debts ashore.',
        },
      },
    })
    campaignId = created.campaignId
    log('campaign_created', { campaignId })
  }

  await pollFor(
    () => api<StatusResp>('GET', `/api/campaigns/${campaignId}`),
    (v) => v.world.status === 'complete' || v.world.status === 'failed',
    { timeoutMs: 25 * 60_000, intervalMs: 10_000, label: 'world complete' },
  )
  log('world_complete', { campaignId })

  await api('POST', `/api/campaigns/${campaignId}/starting-situation`, { index: 0 })
  log('situation_chosen', { campaignId })

  await api('POST', `/api/campaigns/${campaignId}/characters`, {
    conceptText:
      'A road-weary cartographer who lost their ship and now maps the harbor district for coin and a warm hearth.',
    situationGroundingText:
      'Arrived at the starting situation seeking passage out, but the tide and the debts have other plans for them.',
  })
  log('character_submitted', { campaignId })

  await pollFor(
    () =>
      api<{ totalMembers: number; concepts: readonly { status: string }[]; missing: readonly unknown[] }>(
        'GET',
        `/api/campaigns/${campaignId}/character-creation-progress`,
      ),
    (v) =>
      v.missing.length === 0 &&
      v.concepts.length === v.totalMembers &&
      v.concepts.every((c) => c.status === 'completed' || c.status === 'failed'),
    { timeoutMs: 20 * 60_000, intervalMs: 10_000, label: 'character creation' },
  )
  log('characters_ready', { campaignId })

  await api('POST', `/api/campaigns/${campaignId}/finalize-character-creation`, {})
  const final = await pollFor(
    () => api<StatusResp>('GET', `/api/campaigns/${campaignId}`),
    (v) => v.campaign.status === 'active' || v.campaign.status === 'failed',
    { timeoutMs: 15 * 60_000, intervalMs: 10_000, label: 'campaign active' },
  )
  if (final.campaign.status !== 'active') throw new Error(`campaign final status = ${final.campaign.status}`)
  log('campaign_active', { campaignId })
  process.stdout.write(`\nCAMPAIGN_ID=${campaignId}\n`)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
