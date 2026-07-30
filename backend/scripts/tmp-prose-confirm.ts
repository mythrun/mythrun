/* Throwaway: 3-draw confirmation for the finalized prose-register block.
 *
 * Holds EVERYTHING at the current working tree and varies only the shared
 * register block, so the delta is attributable to the block alone:
 *   NONE    — the {{include:…}} directive stripped (no register at all)
 *   SHIPPED — git HEAD's prose-register.txt (the F-shaped block, no exemplar)
 *   NEW     — the working tree's block (F-shaped + B's exemplar)
 *
 * Run: pnpm --filter @mythrun/backend exec tsx --env-file=.env.development scripts/tmp-prose-confirm.ts
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateText } from '../src/llm/ai.js'
import { SONNET } from '../src/llm/models.js'

const REPO = resolve(import.meta.dirname, '../..')
const P = (rel: string): string => `backend/src/llm/prompts/${rel}`
const DIRECTIVE = '{{include:shared/prose-register}}'

const NEW_BLOCK = readFileSync(resolve(REPO, P('shared/prose-register.txt')), 'utf8').trim()
const SHIPPED_BLOCK = execFileSync('git', ['show', `HEAD:${P('shared/prose-register.txt')}`], {
  cwd: REPO,
  encoding: 'utf8',
}).trim()

type Cell = 'NONE' | 'SHIPPED' | 'NEW'
const ALL_CELLS: Cell[] = ['NONE', 'SHIPPED', 'NEW']
const wanted = (process.env.CELLS ?? '').split(',').map((c) => c.trim()).filter(Boolean)
const CELLS: Cell[] = wanted.length ? ALL_CELLS.filter((c) => wanted.includes(c)) : ALL_CELLS

function render(rel: string, cell: Cell, vars: Record<string, string>): string {
  const raw = readFileSync(resolve(REPO, P(rel)), 'utf8')
  const block = cell === 'NONE' ? '' : cell === 'SHIPPED' ? SHIPPED_BLOCK : NEW_BLOCK
  let out = raw.split(DIRECTIVE).join(block)
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v)
  if (out.includes('{{')) throw new Error(`unresolved var in ${rel}: ${out.slice(out.indexOf('{{'), 60)}`)
  return out
}

// ---- Surface 1: Fast Thinker play turn ----
const FT_CONTEXT = `## World
Greywater is a river-mouth town of tanners and ferry crews. Coin is tight; the guild that runs the docks (the Ropewalk) sets the wages and everyone resents it quietly.

## Where the party is
The Salt Kettle — a dockside tavern. Known facts:
- The common room is low-ceilinged, smells of tallow and wet rope, and stays half-full at any hour.
- A rack of plain practice blades sits on the wall behind the bar; the owner, Maddox Ferrin, lets dock crews spar in the yard out back for a copper.
- There is a back room the regulars use for dice; Maddox keeps its door shut.

## NPCs present
- Maddox Ferrin — owner. Broad, unhurried, watches the room while he works.

## Party ledger (turn-start state)
[Party ledger: Onwe — HP 22/22, 6gp. Sil — HP 18/18, 11gp.]`

const FT_VARS = { party_roster: 'Onwe (human ranger), Sil (halfling rogue)', ft_context: FT_CONTEXT }
const FT_USER = 'Onwe: I shoulder open the tavern door and step inside, taking a slow look around the common room.'

// ---- Surface 2: world-gen kernel (first prep stage) ----
const WF_VARS = {
  worldName: 'Greywater',
  concept:
    'A river-mouth town where the dock guild sets every wage and no one can prove it skims them. Grounded, wry, working-class fantasy. Small loyalties, debt, and the question of who really runs a place.',
  vocabularyRegistry:
    '- Ropewalk: the guild that controls the docks and sets dock wages.\n- copper-sparring: paying a copper to use a tavern yard to spar.',
}

// ---- Surface 3: starting situation ----
const SS_VARS = {
  name: 'Greywater',
  tone: 'grounded, wry, working-class fantasy',
  themes: 'labor and debt, small loyalties, who really runs a town',
  vocabularyRegistry:
    '- Ropewalk: the guild that controls the docks and sets dock wages.\n- copper-sparring: paying a copper to use a tavern yard to spar.',
  locations_summary:
    "- The Salt Kettle: a dockside tavern; practice blades on the wall, a shut back room for dice, a sparring yard out back.\n- The Ropewalk Hall: the dock guild's counting-house on the quay.\n- Tanners' Row: the reeking street of hide-workers upriver.",
  npcs_summary:
    '- Maddox Ferrin: owner of the Salt Kettle; keeps the peace, watches everyone.\n- Vesna Cole: a Ropewalk clerk who signs the wage-books.',
  factions_summary: '- The Ropewalk: the guild that runs the docks and sets wages; widely resented.',
  key_tensions:
    'The Ropewalk skims the dock wages and no one can prove it. A ferry crew is one bad week from walking off the job.',
  canonical_names:
    "Canonical names: Greywater, The Salt Kettle, The Ropewalk Hall, Tanners' Row, Maddox Ferrin, Vesna Cole, The Ropewalk.",
}

interface Surface {
  id: string
  title: string
  rel: string
  vars: Record<string, string>
  user?: string
}

const SURFACES: Surface[] = [
  {
    id: 'ft',
    title: 'Fast Thinker play turn (opening narration)',
    rel: 'session/ft-system.txt',
    vars: FT_VARS,
    user: FT_USER,
  },
  {
    id: 'kernel',
    title: 'World-gen kernel (prep stage 1: world & factions)',
    rel: 'prep/world-and-factions.txt',
    vars: WF_VARS,
  },
  {
    id: 'ss',
    title: 'Starting situation (prep: the three opening scenes)',
    rel: 'prep/starting-situation.txt',
    vars: SS_VARS,
  },
]

async function draw(s: Surface, cell: Cell): Promise<string> {
  const rendered = render(s.rel, cell, s.vars)
  const r = s.user
    ? await generateText({ model: SONNET, system: rendered, prompt: s.user })
    : await generateText({ model: SONNET, prompt: rendered })
  return (r.text.trim().split('[[')[0] ?? '').trim()
}

async function main(): Promise<void> {
  const N = Number(process.env.N ?? '3')
  const only = (process.env.ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const surfaces = only.length ? SURFACES.filter((s) => only.includes(s.id)) : SURFACES

  let md = `# Prose-register 3-draw confirmation — ${new Date().toISOString()}\n\n`
  md += `Sonnet (FT tier), N=${N} per cell. Everything held at the working tree; only the shared register block varies.\n`
  md += `**NONE** = include stripped · **SHIPPED** = git HEAD block (no exemplar) · **NEW** = working tree (exemplar added).\n`

  for (const s of surfaces) {
    md += `\n## ${s.title}\n\n\`${s.rel}\`\n`
    for (const cell of CELLS) {
      md += `\n### ${cell}\n`
      for (let i = 0; i < N; i++) {
        process.stderr.write(`${s.id} / ${cell} / draw ${i + 1}...\n`)
        const text = await draw(s, cell)
        md += `\n**Draw ${i + 1}**\n\n${text
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}\n`
      }
    }
  }
  process.stdout.write(md)
}

main().catch((e: unknown) => {
  process.stderr.write(String(e) + '\n')
  process.exit(1)
})
