/* Throwaway A/B harness for the prose-register fix. Renders OLD (git HEAD) vs
 * NEW (working tree) prompts with IDENTICAL inputs and calls the real model.
 * Run: pnpm --filter @mythrun/backend exec tsx --env-file=.env.development scripts/tmp-prose-register-ab.ts
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateText } from '../src/llm/ai.js'
import { resolveIncludes } from '../src/llm/prompts.js'
import { SONNET } from '../src/llm/models.js'

const REPO = resolve(import.meta.dirname, '../..')
const P = (rel: string): string => `backend/src/llm/prompts/${rel}`

function oldRaw(rel: string): string {
  // OLD = HEAD version (no register). resolveIncludes is a no-op on it.
  return execFileSync('git', ['show', `HEAD:${P(rel)}`], { cwd: REPO, encoding: 'utf8' })
}
function newRaw(rel: string): string {
  // NEW = working tree, with the {{include:…}} resolved.
  return resolveIncludes(readFileSync(resolve(REPO, P(rel)), 'utf8'))
}
function fill(t: string, vars: Record<string, string>): string {
  let out = t
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v)
  return out
}

// ---- Scenario A: FT opening narration (baited tavern) ----
const PARTY = 'Onwe (human ranger), Sil (halfling rogue)'
const FT_CONTEXT = `## World
Greywater is a river-mouth town of tanners and ferry crews. Coin is tight; the guild that runs the docks (the Ropewalk) sets the wages and everyone resents it quietly.

## Where the party is
The Salt Kettle — a dockside tavern. Known facts:
- The common room is low-ceilinged, smells of tallow and wet rope, and stays half-full at any hour.
- A rack of plain practice blades sits on the wall behind the bar; the owner, Maddox Ferrin, lets dock crews spar in the yard out back for a copper.
- There is a back room the regulars use for dice; Maddox keeps its door shut.

## Party ledger (turn-start state)
[Party ledger: Onwe — HP 22/22, 6gp. Sil — HP 18/18, 11gp.]`

const FT_USER = 'Onwe: I shoulder open the tavern door and step inside, taking a slow look around the common room.'

// ---- Scenario B: starting-situation stage ----
const SS_VARS: Record<string, string> = {
  name: 'Greywater',
  tone: 'grounded, wry, working-class fantasy',
  themes: 'labor and debt, small loyalties, who really runs a town',
  vocabularyRegistry: '- Ropewalk: the guild that controls the docks and sets dock wages.\n- copper-sparring: paying a copper to use a tavern yard to spar.',
  locations_summary:
    '- The Salt Kettle: a dockside tavern; practice blades on the wall, a shut back room for dice, a sparring yard out back.\n- The Ropewalk Hall: the dock guild\'s counting-house on the quay.\n- Tanners\' Row: the reeking street of hide-workers upriver.',
  npcs_summary:
    '- Maddox Ferrin: owner of the Salt Kettle; keeps the peace, watches everyone.\n- Vesna Cole: a Ropewalk clerk who signs the wage-books.',
  factions_summary: '- The Ropewalk: the guild that runs the docks and sets wages; widely resented.',
  key_tensions: 'The Ropewalk skims the dock wages and no one can prove it. A ferry crew is one bad week from walking off the job.',
  canonical_names: 'Canonical names: Greywater, The Salt Kettle, The Ropewalk Hall, Tanners\' Row, Maddox Ferrin, Vesna Cole, The Ropewalk.',
}

async function ft(variant: 'OLD' | 'NEW', n: number): Promise<string[]> {
  const raw = variant === 'OLD' ? oldRaw('session/ft-system.txt') : newRaw('session/ft-system.txt')
  const system = fill(raw, { party_roster: PARTY, ft_context: FT_CONTEXT })
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const r = await generateText({ model: SONNET, system, prompt: FT_USER })
    out.push(r.text.trim())
  }
  return out
}

async function ss(variant: 'OLD' | 'NEW', n: number): Promise<string[]> {
  const raw = variant === 'OLD' ? oldRaw('prep/starting-situation.txt') : newRaw('prep/starting-situation.txt')
  const prompt = fill(raw, SS_VARS)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const r = await generateText({ model: SONNET, prompt })
    out.push(r.text.trim())
  }
  return out
}

function section(title: string, samples: string[]): string {
  return (
    `\n### ${title}\n\n` +
    samples.map((s, i) => `**Sample ${i + 1}**\n\n${s}\n`).join('\n---\n\n')
  )
}

async function main(): Promise<void> {
  const N = Number(process.env.N ?? '3')
  const which = process.env.WHICH ?? 'all' // all | ft | ss
  let md = `# Prose-register A/B — ${new Date().toISOString()}\n\nModel: ${'claude-sonnet-5'} · N=${N} per cell\n`
  if (which === 'all' || which === 'ft') {
    md += `\n## Scenario A — FT opening narration (baited tavern)\n`
    md += section('OLD (HEAD, no register)', await ft('OLD', N))
    md += section('NEW (register block)', await ft('NEW', N))
  }
  if (which === 'all' || which === 'ss') {
    md += `\n## Scenario B — starting-situation stage (raw JSON output)\n`
    md += section('OLD (HEAD, no register)', await ss('OLD', N))
    md += section('NEW (register block)', await ss('NEW', N))
  }
  process.stdout.write(md)
}

main().catch((e: unknown) => {
  process.stderr.write(String(e) + '\n')
  process.exit(1)
})
