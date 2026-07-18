// backend/scripts/smoke/ft-multiplayer-agency.ts
//
// myth-ph544 — the multiplayer PLAYER-AGENCY eval. Real Sonnet. Reproduces the
// exact puppeting trigger in a CLEAN, uncontaminated context (no prior puppet
// in-history to imitate) and asks a Haiku judge whether the FT authored speech,
// decisions, or movement for a player character OTHER than the one who just
// acted. Runs the SAME scenarios against the OLD prompt (git HEAD) and the NEW
// prompt (working tree) so the fix's delta is visible, not asserted.
//
// The bug (session 019f7315, seq 30): a DM turn opened with a question to a
// silent PC hanging, and the FT answered FOR that PC — "Onwe Tass: Onwe takes
// the question straight. '...'" — continuing the players' attributed input
// format and even rolling a check on the invented action. The classifier is
// NOT at fault (it correctly sits back on PC-to-PC address, verified by probe);
// the FT is the actor.
//
// Manual (real LLM ~$0.10), NOT in CI. No DB. Run from backend/:
//   node ./node_modules/tsx/dist/cli.mjs --env-file=.env.development scripts/smoke/ft-multiplayer-agency.ts

import { execFileSync } from 'node:child_process'
import { generateText as sdkGenerateText } from 'ai'
import { buildModelMessages } from '../../src/session/tiers/fast-thinker.js'
import type { FtTurnContext, ConversationMessage } from '../../src/session/tiers/types.js'
import { FT_MODEL } from '../../src/session/ft-config.js'
import { generateObject } from '../../src/llm/ai.js'
import { HAIKU } from '../../src/llm/models.js'
import { z } from 'zod'

const SCENE =
  'The Outer Lanes of Everlantern at night, after the party left the tavern. Public scene facts only. Party: Brenna Kell (caravan outrider), Onwe Tass (wax-scribe/notary).'

function userMsg(characterName: string, text: string): ConversationMessage {
  return { v: 1, role: 'user', parts: [{ kind: 'text', text }], characterName }
}
function dmMsg(text: string): ConversationMessage {
  return { v: 1, role: 'assistant', parts: [{ kind: 'text', text }] }
}

interface Scenario {
  readonly label: string
  readonly justActed: string
  readonly history: readonly ConversationMessage[]
}

const SCENARIOS: readonly Scenario[] = [
  {
    label: 'S1 — Brenna asks Onwe a direct question, then goes silent',
    justActed: 'Brenna Kell',
    history: [
      dmMsg(
        'The lane is cold and half-dark, the cobalt pole-lamps thinning out to the north. A dead lantern-bracket juts from the wall, its wick short and recently burned.',
      ),
      userMsg(
        'Brenna Kell',
        "Brenna turns to Onwe in the dark. 'Notary. You read the wax. I'm asking you straight — is somebody relighting these dead posts on purpose? And if they are, do we take what we've got to the Wick-House at Firstgold, or somewhere quieter tonight? Your call.' She stops there, watching him, and says nothing else — done talking until he answers.",
      ),
    ],
  },
  {
    label: 'S2 — warden challenges Onwe; Brenna defers; DM takes the beat (the seq-30 condition)',
    justActed: 'Brenna Kell',
    history: [
      userMsg(
        'Onwe Tass',
        "Onwe approaches the hooded warden, hands visible, his yard-measure grounded. 'Warden. Onwe Tass, notary. I'd ask about the flame-records.'",
      ),
      dmMsg(
        "The warden doesn't move. 'Tass.' He repeats the name like he's checking it against a list he keeps in his head. 'And what makes a notary think someone died here that the records don't show?' The question hangs in the cold, and he waits.",
      ),
      userMsg(
        'Brenna Kell',
        'Brenna shifts her weight a half-step, buying a breath of time, and keeps her eyes on the warden’s hands and the amber lamp at his belt.',
      ),
    ],
  },
  {
    label: 'S3 — Brenna asks Onwe an EXPERT question that demands his knowledge (the live-playtest gap)',
    justActed: 'Brenna Kell',
    history: [
      userMsg('Onwe Tass', "Onwe caps his inkhorn. 'The ledger doesn't lie. People lie to ledgers.'"),
      dmMsg("The notary's words settle in the low room. Bel, behind the bar, keeps her back mostly turned."),
      userMsg(
        'Brenna Kell',
        "Brenna lays it out flat: three lamps dark on the east road — ninth, tenth, and the last before the marker — and nobody on her caravan clocked it but her, not even the driver who's walked it twenty years. She holds the notary's eye. 'So you tell me, ledger-man — what kind of dark is that?'",
      ),
    ],
  },
]

function buildCtx(history: readonly ConversationMessage[]): FtTurnContext {
  return {
    campaignId: '00000000-0000-0000-0000-000000000000',
    ftContext: SCENE,
    ftHistory: history,
    participants: ['Brenna Kell', 'Onwe Tass'],
    usage: { input: 0, output: 0 },
    workingSet: [],
  }
}

const oldPrompt = execFileSync(
  'git',
  ['show', 'HEAD:backend/src/llm/prompts/session/ft-system.txt'],
  { encoding: 'utf8' },
)
  .replace('{{party_roster}}', 'Brenna Kell, Onwe Tass')
  .replace('{{ft_context}}', SCENE)

const VerdictSchema = z.object({
  puppeted: z.boolean(),
  offendingQuote: z.string(),
  explanation: z.string(),
})

async function judge(justActed: string, dmOutput: string): Promise<z.infer<typeof VerdictSchema>> {
  const r = await generateObject({
    model: HAIKU,
    schema: VerdictSchema,
    schemaName: 'PuppetVerdictSchema',
    system:
      'You audit a tabletop DM turn for ONE violation only: did the DM author SPEECH, DECISIONS, MOVEMENT, EQUIPMENT, or a TOOL/DICE action for a PLAYER CHARACTER who is NOT the one who just acted?\n\nThe ONLY player characters are: Brenna Kell and Onwe Tass. EVERYONE ELSE named (Bel, Old Renn, the warden, Aldric, any keeper, any townsperson) is an NPC the DM controls FREELY — narrating their speech, movement, and reactions is CORRECT and is NOT a violation. Narrating the world, the environment, and the acting PC\'s own established situation is also fine.\n\nA violation is ONLY: the DM putting words in the mouth of / deciding actions for / moving / rolling or looking up knowledge for the NON-ACTING player character (whichever of Brenna/Onwe did NOT just act). A line beginning "Onwe Tass:" or "Brenna Kell:" quoting the non-acting PC, or their dialogue/decisions/movement authored by the DM, is a violation. Set puppeted=true ONLY for that; quote the exact offending text, else "".',
    prompt: `The two player characters are Brenna Kell and Onwe Tass.\nThe PC who JUST ACTED (whose turn the DM is answering): ${justActed}.\nThe PC the DM must NOT play this turn: ${justActed === 'Brenna Kell' ? 'Onwe Tass' : 'Brenna Kell'}.\nEveryone else in the text is an NPC and may be narrated freely.\n\nDM TURN OUTPUT:\n"""\n${dmOutput}\n"""`,
    repairStrategy: 'haiku-then-sonnet',
    timeoutMs: 30_000,
    callSite: 'ft-agency-judge',
  })
  return r.output
}

async function runVariant(label: string, systemOverride: string | null, s: Scenario): Promise<void> {
  const messages = buildModelMessages(buildCtx(s.history))
  const first = messages[0]
  if (systemOverride !== null && first !== undefined) {
    messages[0] = { ...first, content: systemOverride } as (typeof messages)[number]
  }
  const res = await sdkGenerateText({ model: FT_MODEL, messages })
  const text = (res.text.split('[[WORLD_DELTA]]')[0] ?? res.text).trim()
  const v = await judge(s.justActed, text)
  process.stdout.write(
    `\n  [${label}] puppeted=${v.puppeted ? 'YES ❌' : 'no ✅'}\n` +
      (v.puppeted ? `    offending: ${v.offendingQuote}\n` : '') +
      `    judge: ${v.explanation}\n` +
      `    ── DM output (head) ──\n    ${text.slice(0, 420).replace(/\n/g, '\n    ')}\n`,
  )
}

async function main(): Promise<void> {
  for (const s of SCENARIOS) {
    process.stdout.write(`\n════════ ${s.label} ════════`)
    await runVariant('OLD prompt', oldPrompt, s)
    await runVariant('NEW prompt', null, s)
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`${String(e)}\n`)
    process.exit(1)
  },
)
