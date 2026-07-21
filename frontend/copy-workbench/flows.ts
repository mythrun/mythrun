import { data, entriesByKey } from './store.ts'
import type { Entry } from './types.ts'

/** Ordered flow metadata — the left-rail order + friendly labels. Any flow present
 *  in the data but missing here is appended with a derived label. */
export const FLOW_META: { id: string; label: string; blurb: string }[] = [
  { id: 'landing', label: 'Landing', blurb: 'The public front door — hero, tagline, CTA.' },
  { id: 'signin', label: 'Sign in', blurb: 'The auth screen taglines + legal line.' },
  { id: 'callback', label: 'Auth callback', blurb: 'The signing-you-in interstitial.' },
  { id: 'onboard', label: 'Onboarding', blurb: 'The "what should we call you?" first step.' },
  { id: 'home', label: 'Home hub', blurb: 'The campaign shelf + card states.' },
  { id: 'campaignNew', label: 'New campaign', blurb: 'The world-creation fork: idea vs. what-you-love.' },
  { id: 'worldGen', label: 'World generation', blurb: 'The loading + streaming-graph + stage labels.' },
  { id: 'worldReveal', label: 'World reveal', blurb: 'The "meet your world" wiki + explore.' },
  { id: 'startingLevel', label: 'Starting level', blurb: 'Pick the party start level.' },
  { id: 'startingSituation', label: 'Starting situation', blurb: 'Pick the opening hook.' },
  { id: 'characterCreate', label: 'Character creation', blurb: 'Guided + freeform build, loading, reveal, party.' },
  { id: 'campaign', label: 'Campaign page', blurb: 'The campaign landing + character-ready states.' },
  { id: 'join', label: 'Join invite', blurb: 'The public invite landing.' },
  { id: 'play', label: 'Play session', blurb: 'The live table: input, rolls, thinking, knowledge.' },
  { id: 'billing', label: 'Billing', blurb: 'Packs, history, checkout, purchase prompts.' },
  { id: 'frame', label: 'App frame', blurb: 'The persistent header — wordmark, name, credits.' },
  { id: 'splash', label: 'Splash', blurb: 'The boot splash line.' },
  { id: 'error', label: 'Error screens', blurb: 'The generic + contract error surfaces.' },
  { id: 'notFound', label: 'Not found', blurb: 'The 404 screen.' },
  { id: 'stub', label: 'Stubs', blurb: 'Placeholder screen labels (dev interim).' },
  { id: 'appGreeting', label: 'Greeting', blurb: 'A test-fixture interpolation string.' },
  { id: 'richSample', label: 'Rich sample', blurb: 'A rich-text <Trans> sample string.' },
  {
    id: 'ds',
    label: 'DS defaults',
    blurb:
      'Strings HARDCODED in @mythrun/ui components (not i18n keys). Editable + exported under ds: keys; the live example is a context card since the constant is frozen in source.',
  },
]

// ── Dead / unwired detection (flag-driven) ───────────────────────────────────
/** A key the suggestion authors judged dead / not-wired / test-only — routed to a
 *  compact "proposed for deletion" strip (criticism preserved so it can be vetoed). */
export function isDeadKey(entry: Entry): boolean {
  return entry.flags.some(
    (f) => f.startsWith('dead-key') || f.startsWith('likely-dead') || f.startsWith('test-fixture'),
  )
}

/** Human reason for the dead-strip badge. */
export function deadReason(entry: Entry): string {
  const f = entry.flags.find(
    (x) => x.startsWith('dead-key') || x.startsWith('likely-dead') || x.startsWith('test-fixture'),
  )
  if (!f) return 'proposed for deletion'
  if (f.startsWith('test-fixture')) return 'test fixture — not a product string'
  if (f.startsWith('likely-dead')) return 'likely dead — no usage found'
  const detail = f.includes(':') ? f.slice(f.indexOf(':') + 1).trim() : ''
  return detail !== '' ? `not wired — ${detail}` : 'not wired into the UI today'
}

export type FlowItem =
  | { type: 'single'; key: string }
  | { type: 'group'; groupId: string; keys: string[] }

export interface Flow {
  id: string
  label: string
  blurb: string
  keys: string[]
  items: FlowItem[]
}

function labelFor(id: string): string {
  const meta = FLOW_META.find((m) => m.id === id)
  if (meta) return meta.label
  return id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
}

function blurbFor(id: string): string {
  return FLOW_META.find((m) => m.id === id)?.blurb ?? ''
}

/** Build the ordered flows, grouping each flow's keys into single-key + group items
 *  (group members share a `groupId`, kept in first-appearance order). */
export function buildFlows(): Flow[] {
  const byFlow = new Map<string, string[]>()
  for (const key of data.order) {
    const entry = entriesByKey[key]
    if (!entry) continue
    const list = byFlow.get(entry.flow) ?? []
    list.push(key)
    byFlow.set(entry.flow, list)
  }

  const orderedIds = [
    ...FLOW_META.map((m) => m.id).filter((id) => byFlow.has(id)),
    ...[...byFlow.keys()].filter((id) => !FLOW_META.some((m) => m.id === id)),
  ]

  return orderedIds.map((id) => {
    const keys = byFlow.get(id) ?? []
    const items: FlowItem[] = []
    const groupIndex = new Map<string, number>()
    for (const key of keys) {
      const g = entriesByKey[key]?.groupId
      if (g) {
        const at = groupIndex.get(g)
        if (at === undefined) {
          groupIndex.set(g, items.length)
          items.push({ type: 'group', groupId: g, keys: [key] })
        } else {
          const item = items[at]
          if (item && item.type === 'group') item.keys.push(key)
        }
      } else {
        items.push({ type: 'single', key })
      }
    }
    return { id, label: labelFor(id), blurb: blurbFor(id), keys, items }
  })
}

// ── Context-card role inference ──────────────────────────────────────────────
export type CtxRole =
  | { tag: 'heading'; level: 2 | 3 | 4; role: 'display' | 'heading' | 'title'; label: string }
  | { tag: 'text'; role: 'prose-body' | 'subtitle' | 'ui-label' | 'ui-caption' | 'data' | 'meta'; label: string }
  | { tag: 'button'; label: string }

const BUTTON_WORDS =
  /(cta|retry|begin|send|summon|buy|continue|next|back|close|open|find|watch|subscribe|upgrade|manage|confirm|enter|roll|cancel|startOver|start|switchTo|editAsFreeform|askChange|rework|portalLink|viewHistory|createCampaign|buyCredits)/i

/** Pick a faithful DS type role for a key's context card. A light heuristic — this
 *  is internal tooling, and the floor requirement is "the right type role on the
 *  right ground," not perfect fidelity. */
export function inferRole(entry: Entry): CtxRole {
  const seg = entry.key.split('.').pop() ?? entry.key
  const lower = seg.toLowerCase()

  if (/(^|\.)title$/i.test(entry.key) || lower === 'title' || lower === 'holdtitle') {
    return { tag: 'heading', level: 2, role: 'title', label: 'title · serif' }
  }
  if (lower === 'prompt' || lower === 'question' || lower.endsWith('question')) {
    return { tag: 'heading', level: 2, role: 'title', label: 'question · serif' }
  }
  if (lower === 'eyebrow') {
    return { tag: 'text', role: 'ui-caption', label: 'eyebrow · caption' }
  }
  if (lower === 'tagline' || lower === 'lede' || lower === 'subtitle' || lower.endsWith('subtitle')) {
    return { tag: 'text', role: 'subtitle', label: 'subtitle' }
  }
  if (BUTTON_WORDS.test(seg)) {
    return { tag: 'button', label: 'button / action label' }
  }
  if (
    /(body|detail|hint|whisper|gloss|blurb|lede|grant\d|message|fallback|body|explain)/i.test(seg) ||
    entry.kind === 'multiline'
  ) {
    return { tag: 'text', role: 'prose-body', label: 'prose / body' }
  }
  if (/(label|credits|hp|dc|record|price|amount|countdown|step|indicator|count|entities)/i.test(seg)) {
    return { tag: 'text', role: 'ui-label', label: 'ui label' }
  }
  return { tag: 'text', role: 'prose-body', label: 'body' }
}
