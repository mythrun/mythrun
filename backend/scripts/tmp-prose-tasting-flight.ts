/* Throwaway: prose-register TASTING FLIGHT. Same scene briefs, one shared FT
 * framing, register block swapped per candidate. Real Sonnet (FT tier).
 * Run: pnpm --filter @mythrun/backend exec tsx --env-file=.env.development scripts/tmp-prose-tasting-flight.ts
 * Emits the full tasting-flight.md to stdout.
 */
import { generateText } from '../src/llm/ai.js'
import { SONNET } from '../src/llm/models.js'

// Shared FT narration framing — the load-bearing prose posture that ships TODAY,
// lifted from ft-system (Prose Rules + Narrative Camera + Entity Reminders).
// Baseline = this alone. Candidates = this + their register block appended.
const SHARED_FRAMING = `You are the Dungeon Master for a D&D 5e session. Narrate the scene the party has just entered.

## Prose Rules
Write vivid, sensory prose. Every location feels different: temperature, smell, sound, light. No info-dumps, no exposition monologues. Show, don't tell.
Match the tone the scene calls for. You can be funny, mundane, tense, warm, eerie, or urgent — not every moment needs to be atmospheric and heavy.

## Narrative Camera
Show, never interpret. NPC reactions are behavior only: hands, voice, eyes, pauses. The players draw the conclusions.

## Entity Reminders
Assume the players have terrible memory. Every NPC and location name comes with one clause of context, woven naturally into the prose.

## This turn
Narrate the scene below as scene-setting description — one solid paragraph (4–8 sentences). No dialogue required; you are painting the place the party has walked into. Use the concrete facts given. Output only the narration.`

// ---- Candidate register blocks (distinct methodologies) ----
const CANDIDATES: Record<string, { desc: string; block: string }> = {
  Baseline: {
    desc: 'Current Mythrun prose guidance only (vivid/sensory + show-don’t-tell). No register block.',
    block: '',
  },
  A: {
    desc: 'Negative catalog — a list of banned AI-prose constructions to cut, minimal positive framing.',
    block: `## Prose Register
When you write description, cut the following constructions. They are the tells of machine-written prose:
- Negation-flourish: "It wasn't a tavern. It was a warning." / "no ordinary road, but a summons."
- The three-beat cadence: three stacked phrases or adjectives ("unspoken, unremarked, and unmistakably there").
- Faux-knowing hedges: "seems to," "something about the way," "depending on who you ask."
- Mystery-signaling: telling the reader a thing is significant or hides more than it shows ("there was more to it than met the eye").
- The dramatic one-line closer dropped as its own paragraph for effect.
- Atmosphere-claims in place of detail: "the air itself," "a heavy silence," "a weight settled over the room."
- Copula-dodging puffery: "serves as," "stands as a testament to," "boasts."
- Piled-up em-dash asides.
Write plainly instead.`,
  },
  B: {
    desc: 'Positive exemplar — two target passages to imitate; almost no prohibitions.',
    block: `## Prose Register
Write description in this register — concrete, observed, unhurried, trusting the reader:

  The common room is low and warm. Fat lamps, a smell of tallow and wet rope. A dozen dockhands sit at the benches; none look up. Behind the bar a broad man moves cups from one end to the other and keeps half an eye on the door.

  Rain has stopped, but the street still runs with it. The fish stalls are shutting; a boy sweeps guts toward the gutter. At the far end the guild hall keeps its lamps lit while the rest of the row goes dark.

Notice what these do: specific objects, plain verbs, no words telling you how to feel, no flourish at the end. They state what is there and stop. Write your description the same way.`,
  },
  C: {
    desc: 'Voice description — the desired register named as a style/voice; no list, no example.',
    block: `## Prose Register
Write in a plain, concrete register. The voice you want is the one that undersells: it names things exactly, uses ordinary words, and trusts the reader to feel the weight without being told. Warmth and specificity, never hype or portent. It would rather show you the mud dried on a boot than tell you the road was hard. Describe scenes that way — the specific object over the general mood, the plain sentence over the ornamented one.`,
  },
  D: {
    desc: 'Minimal terse rules — four imperatives, no examples.',
    block: `## Prose Register
Four rules for all description:
1. Concrete over atmospheric — name the object, not the mood.
2. Don't announce meaning; show one detail and stop.
3. Vary sentence length; plain declaratives are fine.
4. Cut any sentence that only sets a mood and states no fact.`,
  },
  E: {
    desc: 'Narrative-level — targets deep tells (no theme-explaining, no moralizing, no tidy wrap-up, vary intensity); ignores surface tics.',
    block: `## Prose Register
How you handle meaning matters more than word choice:
- Do not explain the point of a scene. Present what is there and let the players draw the meaning. If you catch yourself telling the reader what a moment signifies, delete that sentence.
- Do not moralize or comment as narrator. You report; you do not editorialize.
- Do not tie the scene off neatly. Leave it a little open, the way real moments are.
- Let intensity vary. Do not describe an ordinary doorway with the same weight as a death. Keep the register low; save the heightened note for what genuinely earns it.
- Trust the reader. What you leave unsaid they will feel, if what you do say is true and specific.`,
  },
  F: {
    desc: 'Combined — each ban paired with its positive alternative + an exemplar + narrative-level rules + explicit scope.',
    block: `## Prose Register
This register applies to every passage you write, every turn — not only the examples below.

Write concrete, observed, restrained description. Name specific things in plain words and trust the reader to feel their weight. Do not tell the reader what to feel or what a moment means.

Replace the machine-writing tells with their honest form:
- Instead of negation-flourish ("It wasn't a tavern. It was a warning."), state the thing directly.
- Instead of a three-beat cadence ("unspoken, unremarked, and unmistakably there"), say it once.
- Instead of hedges ("seems to," "something about the way"), commit to what is there or leave it out.
- Instead of signaling mystery ("more than meets the eye"), show one real detail and stop.
- Instead of atmosphere-claims ("the air itself," "a heavy silence"), give the concrete source of the mood.
- Instead of a profound one-line closer, end on an image, not a verdict.

Do not explain the scene's meaning, do not moralize as narrator, and do not wrap the moment up tidily. Let intensity vary — an ordinary street gets an ordinary register; save the heightened note for what earns it.

Target register:

  The common room is low and warm. Fat lamps, a smell of tallow and wet rope. A dozen dockhands sit at the benches; none look up. Behind the bar a broad man moves cups from one end to the other and keeps half an eye on the door.

Write everything in that register.`,
  },
}

const ORDER = ['Baseline', 'A', 'B', 'C', 'D', 'E', 'F']

// ---- Scene briefs (general descriptive D&D/Mythrun work) ----
const SCENES: { id: string; title: string; brief: string; user: string }[] = [
  {
    id: 's1',
    title: 'Tavern interior, party entering',
    brief: 'The party pushes into a dockside tavern in a working river town.',
    user: `The party pushes open the door of the Salt Kettle, a dockside tavern in the river town of Greywater, and steps inside. Concrete facts to use:
- Low-ceilinged common room, smells of tallow and wet rope, half-full at any hour.
- A rack of plain wooden practice blades hangs on the wall behind the bar.
- The owner, Maddox Ferrin, keeps a back room's door shut; regulars use it for dice.
- The crowd is mostly dock crews in rough canvas; a few tanners in leather aprons.
Narrate what the party sees as they enter.`,
  },
  {
    id: 's2',
    title: 'Market street at dusk',
    brief: 'The party turns onto the town market street as the stalls close for the night.',
    user: `The party turns onto the market street of Greywater as the sun goes down. Concrete facts to use:
- Fish and produce stalls are shutting; vendors folding awnings and stacking crates.
- River fog is coming up; the cobbles are slick.
- A lamplighter is working down the row lighting the iron posts.
- At the far end stands the Ropewalk Hall, the dock guild's counting-house, its windows still lit.
Narrate what the party sees as they walk down the street.`,
  },
  {
    id: 's3',
    title: 'Arriving at a forest-edge village',
    brief: 'After a day on the road the party reaches a small village at the tree-line.',
    user: `After a day on the road, the party comes over a rise and sees the village of Thornwick at the edge of the forest. Concrete facts to use:
- A dozen timber houses behind a low palisade of split logs.
- Chimney smoke; sheep in a pen; a woman drawing water at a well.
- The dark tree-line of the forest stands close behind the houses.
- A single muddy track runs in through a gap in the palisade.
Narrate what the party sees as they approach.`,
  },
  {
    id: 's4',
    title: 'An NPC is asked his plan, with none supplied (specificity-feint bait)',
    brief: 'The party asks a hired fixer how he will get them past the harbor watch — but no method is supplied to the DM. This baits the "three plans in my head" feint: enumerated interior content claimed, none named. A good answer commits to concrete specifics or plainly declines; the feint gestures at unnamed depth.',
    user: `The party has hired Rell Sarno, a dock-district fixer, to get them past the harbor watch tonight. Rell is competent and a little cagey — he keeps his methods to himself and doesn't fully trust the party yet. No further facts about how he does it are established.
Onwe: "So how exactly are you getting us past the watch, Rell?"
Narrate Rell's response. You voice Rell and the world only — never decide or voice the player characters.`,
  },
]

async function sample(scene: (typeof SCENES)[number], key: string): Promise<string> {
  const c = CANDIDATES[key]
  if (!c) throw new Error(`unknown candidate ${key}`)
  const system = c.block ? `${SHARED_FRAMING}\n\n${c.block}` : SHARED_FRAMING
  const r = await generateText({ model: SONNET, system, prompt: scene.user })
  return (r.text.trim().split('[[')[0] ?? '').trim()
}

function bq(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
}

async function main(): Promise<void> {
  const only = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const scenes = only.length ? SCENES.filter((s) => only.includes(s.id)) : SCENES
  const results: Record<string, Record<string, string>> = {}
  for (const scene of scenes) {
    const row: Record<string, string> = {}
    results[scene.id] = row
    for (const key of ORDER) {
      process.stderr.write(`generating ${scene.id} / ${key}...\n`)
      row[key] = await sample(scene, key)
    }
  }

  // Spliceable mode: emit only the scene sections (no title/appendix).
  if (only.length) {
    let out = ''
    for (const scene of scenes) {
      out += `\n## Scene ${scene.id.slice(1)} — ${scene.title}\n\n`
      out += `*${scene.brief}*\n`
      for (const key of ORDER) {
        const label = key === 'Baseline' ? 'Baseline' : `Candidate ${key}`
        out += `\n### ${label}\n\n${CANDIDATES[key]?.desc ?? ''}\n\n` + bq(results[scene.id]?.[key] ?? '') + '\n'
      }
    }
    process.stdout.write(out)
    return
  }

  let md = `# Prose register — tasting flight\n\n`
  md += `Real Sonnet (Fast-Thinker tier, \`claude-sonnet-5\`), one draw per cell. `
  md += `Every candidate sees the **same** scene brief and the same base DM framing; only the register block changes. `
  md += `Read the prose first — the methodology behind each candidate is a one-liner here and the full block is in the appendix.\n\n`
  md += `Candidates: **Baseline** (what ships today) · **A** negative catalog · **B** positive exemplar · **C** voice description · **D** minimal rules · **E** narrative-level · **F** combined.\n`

  for (const scene of SCENES) {
    md += `\n## Scene ${scene.id.slice(1)} — ${scene.title}\n\n`
    md += `*${scene.brief}*\n`
    for (const key of ORDER) {
      const label = key === 'Baseline' ? 'Baseline' : `Candidate ${key}`
      md += `\n### ${label}\n\n`
      md += `${CANDIDATES[key]?.desc ?? ''}\n\n`
      md += bq(results[scene.id]?.[key] ?? '') + '\n'
    }
  }

  md += `\n---\n\n## Appendix — full register blocks\n`
  for (const key of ORDER) {
    if (key === 'Baseline') continue
    md += `\n### Candidate ${key} — ${CANDIDATES[key]?.desc ?? ''}\n\n`
    md += '```\n' + (CANDIDATES[key]?.block ?? '') + '\n```\n'
  }
  md += `\n### Shared base framing (identical across all cells)\n\n`
  md += '```\n' + SHARED_FRAMING + '\n```\n'

  process.stdout.write(md)
}

main().catch((e: unknown) => {
  process.stderr.write(String(e) + '\n')
  process.exit(1)
})
