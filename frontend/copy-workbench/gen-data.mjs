// Build-time data assembly for the copy workbench. Reads the copy inventory (all
// 388 [ph:] entries) and the six suggestion files from the copy-pass scratchpad,
// merges suggestions onto entries by `key`, and folds in two families of entries
// that are NOT plain inventory i18n keys:
//   • the FLAVOR CATALOG — one `worldGen.flavor1..flavor20` multiline entry whose
//     lines fan out to the 20 real flavor keys (the largest single surface);
//   • the DS DEFAULTS — 19 `ds:*` entries for [ph:] strings HARDCODED in
//     @mythrun/ui components (not i18n keys; overridden only through the store).
// Writes a single `data.json` the app imports.
//
// Usage: node gen-data.mjs [scratchpadDir]

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const scratch =
  process.argv[2] ??
  '/private/tmp/claude-501/-Users-miklos-Desktop-Files-Mythrun-Code-mythrun/d6f132ad-c3c6-4288-a93c-a0d4224f117d/scratchpad/copy-pass'

const inventory = JSON.parse(readFileSync(join(scratch, 'inventory.json'), 'utf8'))

const SUGGESTION_FILES = [
  'suggestions-shell.json',
  'suggestions-create.json',
  'suggestions-worldgen.json',
  'suggestions-character.json',
  'suggestions-play.json',
  'suggestions-campaign-billing.json',
]

const allSuggestions = []
const suggestionsByKey = new Map()
const present = []
const missing = []
for (const file of SUGGESTION_FILES) {
  const path = join(scratch, file)
  if (!existsSync(path)) {
    missing.push(file)
    continue
  }
  present.push(file)
  const arr = JSON.parse(readFileSync(path, 'utf8'))
  for (const s of arr) {
    if (s && typeof s.key === 'string') {
      allSuggestions.push(s)
      suggestionsByKey.set(s.key, s)
    }
  }
}

function baseEntry(item, s) {
  return {
    key: item.key,
    flow: item.flow,
    current: item.current,
    description: item.description ?? '',
    interpolated: Boolean(item.interpolated),
    usedIn: item.usedIn ?? [],
    kind: s?.kind ?? 'single',
    groupId: s?.groupId ?? null,
    suggestions: s?.suggestions ?? [],
    rationale: s?.rationale ?? '',
    flags: s?.flags ?? [],
    exampleHint: s?.exampleHint ?? '',
    subsumedBy: null,
    targetKeys: null,
    hardcoded: false,
  }
}

const entries = {}
const order = []
for (const item of inventory) {
  entries[item.key] = baseEntry(item, suggestionsByKey.get(item.key))
  order.push(item.key)
}

// ── Flavor catalog (worldGen.flavor1..flavor20) ─────────────────────────────
const CATALOG_KEY = 'worldGen.flavor1..flavor20'
const flavorTargets = Array.from({ length: 20 }, (_, i) => `worldGen.flavor${String(i + 1)}`)
const catalogSug = suggestionsByKey.get(CATALOG_KEY)
if (catalogSug) {
  for (const k of flavorTargets) if (entries[k]) entries[k].subsumedBy = CATALOG_KEY
  entries[CATALOG_KEY] = {
    key: CATALOG_KEY,
    flow: 'worldGen',
    current: '',
    description:
      'The 20 world-gen loading flavor lines, edited as one catalog (one line per entry). Lines fan out to worldGen.flavor1…flavor20 and export as those 20 real keys.',
    interpolated: false,
    usedIn: [],
    kind: 'catalog',
    groupId: null,
    suggestions: catalogSug.suggestions ?? [],
    rationale: catalogSug.rationale ?? '',
    flags: catalogSug.flags ?? [],
    exampleHint: catalogSug.exampleHint ?? '',
    subsumedBy: null,
    targetKeys: flavorTargets,
    hardcoded: false,
  }
  const at = order.indexOf('worldGen.flavor1')
  order.splice(at < 0 ? order.length : at, 0, CATALOG_KEY)
}

// ── DS defaults (ds:*) — [ph:]/label constants hardcoded in @mythrun/ui ──────
// current + kind grepped verbatim from the component sources (file:line in each
// entry's exampleHint). NOT i18n keys — the store owns them; they export as ds:*.
const DS_META = {
  'ds:CharacterLoadingBeat.heading': { current: '[ph: bringing them to life…]', kind: 'single' },
  'ds:creationStream.beat.name': { current: '[ph: a name surfaces]', kind: 'single' },
  'ds:creationStream.beat.class': { current: '[ph: a class and calling take shape]', kind: 'single' },
  'ds:creationStream.beat.scores': { current: '[ph: ability scores settle]', kind: 'single' },
  'ds:creationStream.beat.kit': { current: '[ph: equipment is gathered]', kind: 'single' },
  'ds:FreeformPrompt.submit': { current: 'Continue', kind: 'single' },
  'ds:CharacterSheetReveal.confirm': { current: 'This is me →', kind: 'single' },
  'ds:CharacterSheetReveal.seeFull': { current: 'See full sheet', kind: 'single' },
  'ds:CharacterSheetReveal.startOver': { current: 'Start over', kind: 'single' },
  'ds:CharacterSheetReveal.curatedPanelTitles': {
    current: 'What they can do\nWhat they carry\nWhat they can cast',
    kind: 'multiline',
  },
  'ds:GuidedBuilder.next': { current: 'Next', kind: 'single' },
  'ds:GuidedBuilder.back': { current: 'Back', kind: 'single' },
  'ds:GuidedBuilder.skip': { current: 'Describe them instead', kind: 'single' },
  'ds:PartyRoster.inviteSub': { current: '[ph: share a link · they join here]', kind: 'single' },
  'ds:PartyRoster.creating': { current: '[ph: choosing who they are…]', kind: 'single' },
  'ds:PartyRoster.gathering': { current: '[ph: just joined — making their character…]', kind: 'single' },
  'ds:PartyRoster.waiting': { current: '[ph: waiting for the party to gather…]', kind: 'single' },
  'ds:PartyRoster.beginSolo': { current: '[ph: begin the adventure →]', kind: 'single' },
  'ds:PartyRoster.beginParty': { current: "[ph: everyone's ready — begin →]", kind: 'single' },
}

let dsCount = 0
for (const s of allSuggestions) {
  if (!s.key.startsWith('ds:')) continue
  const meta = DS_META[s.key] ?? { current: '', kind: 'single' }
  entries[s.key] = {
    key: s.key,
    flow: 'ds',
    current: meta.current,
    description: s.rationale ?? '',
    interpolated: false,
    usedIn: [],
    kind: meta.kind,
    groupId: null,
    suggestions: s.suggestions ?? [],
    rationale: s.rationale ?? '',
    flags: s.flags ?? [],
    exampleHint: s.exampleHint ?? '',
    subsumedBy: null,
    targetKeys: null,
    hardcoded: true,
  }
  order.push(s.key)
  dsCount += 1
}

// Authorable string total: every entry except the catalog META key (its 20
// targets are the real strings and are counted individually).
const authorable = order.filter((k) => entries[k].kind !== 'catalog').length

const data = {
  entries,
  order,
  meta: {
    generatedAt: new Date().toISOString(),
    inventoryTotal: inventory.length,
    authorable,
    dsDefaults: dsCount,
    hasCatalog: Boolean(catalogSug),
    suggestionFilesPresent: present,
    suggestionFilesMissing: missing,
  },
}

writeFileSync(join(here, 'data.json'), JSON.stringify(data))
console.log(
  `wrote data.json — ${String(inventory.length)} inventory + ${String(dsCount)} ds-defaults` +
    `${catalogSug ? ' + 1 flavor catalog' : ''}; ${String(authorable)} authorable strings; ` +
    `${String(present.length)}/${String(SUGGESTION_FILES.length)} suggestion files` +
    (missing.length ? `; missing: ${missing.join(', ')}` : ''),
)
