// backend/dev-tool/src/shell/drawer/prose-view.ts
//
// MYT-62 T7: live session-prep PROSE view. Subscribes (via a SECOND
// SubscriptionManager in shell.ts) to the dev-only prose route
// /api/dev/campaigns/:id/prep-prose, which streams `prep-delta` frames:
//   { type: 'prep-delta', field: 'ft_context' | 'sd_playbook', text: '...' }
//
// This is the dev-tool side of the enforced-ignorance boundary: the
// sd_playbook prose may carry plot secrets, so it only ever flows on the
// separate dev-only prep channel + dev-only route. Surfacing it here lets
// an operator watch both the Fast-Thinker context (public) and the Slow-
// Thinker playbook (secret) accumulate during session prep.
//
// Two layers, mirroring buffer.ts (pure) + drawer.ts (DOM):
//   - emptyProseState / applyProseDelta: a pure, testable reducer.
//   - mountProseView: a minimal DOM surface that holds a ProseState,
//     applies incoming deltas, and renders two labeled <pre> panes.
//     Text is set via textContent (never innerHTML), so prose is inert —
//     same escaping discipline as drawer.ts's payload <pre>.

import type { DrawerEvent } from './subscriptions.js'

type ProseField = 'ft_context' | 'sd_playbook'

const PROSE_FIELDS: readonly ProseField[] = ['ft_context', 'sd_playbook'] as const

export interface ProseState {
  readonly ft_context: string
  readonly sd_playbook: string
}

export interface ProseDelta {
  readonly field: ProseField
  readonly text: string
}

export function emptyProseState(): ProseState {
  return { ft_context: '', sd_playbook: '' }
}

export function applyProseDelta(state: ProseState, delta: ProseDelta): ProseState {
  return { ...state, [delta.field]: state[delta.field] + delta.text }
}

export interface ProseViewHandle {
  /** Feed a DrawerEvent. Only `type === 'prep-delta'` events with a valid
   *  field + string text mutate state; everything else is ignored. */
  onEvent(event: DrawerEvent): void
  /** Clear both panes back to empty (campaign switch / identity change). */
  reset(): void
}

function isProseField(v: unknown): v is ProseField {
  return typeof v === 'string' && (PROSE_FIELDS as readonly string[]).includes(v)
}

// Pull a well-formed ProseDelta out of a DrawerEvent.data, or null if the
// payload isn't a usable prep-delta (wrong/missing field, non-string text).
function toProseDelta(data: Record<string, unknown>): ProseDelta | null {
  const field = data.field
  const text = data.text
  if (!isProseField(field)) return null
  if (typeof text !== 'string') return null
  return { field, text }
}

const FIELD_LABELS: Readonly<Record<ProseField, string>> = {
  ft_context: 'ft_context (Fast Thinker — public)',
  sd_playbook: 'sd_playbook (Slow Thinker — secret)',
}

function mountPane(parent: HTMLElement, field: ProseField): HTMLElement {
  const section = document.createElement('section')
  section.setAttribute('data-prose-field', field)
  section.style.marginBottom = '8px'

  const label = document.createElement('div')
  label.className = 'label-small'
  label.style.color = 'var(--fg-emphasis)'
  label.style.marginBottom = '2px'
  label.textContent = FIELD_LABELS[field]
  section.appendChild(label)

  const pre = document.createElement('pre')
  pre.setAttribute('data-prose-text', field)
  pre.style.margin = '0'
  pre.style.padding = '6px 8px'
  pre.style.background = 'var(--bg-default)'
  pre.style.border = '1px solid var(--border-soft)'
  pre.style.borderRadius = '3px'
  pre.style.fontSize = '11px'
  pre.style.lineHeight = '1.5'
  pre.style.whiteSpace = 'pre-wrap'
  pre.style.wordBreak = 'break-word'
  pre.style.color = 'var(--fg-emphasis)'
  // textContent (not innerHTML): prose is rendered inert. Same escaping
  // discipline as the drawer's JSON payload <pre>.
  pre.textContent = ''
  section.appendChild(pre)

  parent.appendChild(section)
  return pre
}

export function mountProseView(parent: HTMLElement): ProseViewHandle {
  const root = document.createElement('div')
  root.setAttribute('data-region', 'prose-view')
  root.style.padding = '6px 10px'
  root.style.fontSize = '11px'

  const title = document.createElement('div')
  title.className = 'label-small'
  title.style.color = 'var(--fg-muted)'
  title.style.marginBottom = '4px'
  title.textContent = 'SESSION PREP PROSE'
  root.appendChild(title)

  const panes: Record<ProseField, HTMLElement> = {
    ft_context: mountPane(root, 'ft_context'),
    sd_playbook: mountPane(root, 'sd_playbook'),
  }

  let state = emptyProseState()

  function render(): void {
    for (const field of PROSE_FIELDS) {
      panes[field].textContent = state[field]
    }
  }

  parent.appendChild(root)

  return {
    onEvent: (event) => {
      if (event.type !== 'prep-delta') return
      const delta = toProseDelta(event.data)
      if (delta === null) return
      state = applyProseDelta(state, delta)
      render()
    },
    reset: () => {
      state = emptyProseState()
      render()
    },
  }
}
