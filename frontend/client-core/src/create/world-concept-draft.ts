// The WORLD-CONCEPT draft seam (myth-5fi4q) — the freeform campaign-create field,
// persisted so a reload, a tab close, or a wander off to the guided path and back
// never costs the player the world they had already described.
//
// The guided sibling in the same funnel has kept its picks since MYT-89 §11
// (guided-draft.ts), while the freeform field next to it held its concept in plain
// `useState`: two paths through one screen, one of which quietly threw the player's
// prose away. This closes that.
//
// Shaped after the CHARACTER draft (../character/character-draft.ts), not after
// guided-draft's configure-once global: the store arrives through an INJECTED
// `SessionDraftStore` port, so this seam adds no boot-file wiring and each test hands
// its own fake with no global to reset. The web realization is localStorage-backed
// (createWebLocalDraftStore) for the same reason character creation is — the player
// writes prose here and then commits it to a slow, credit-metered build, so their
// words should outlive a tab close, not just a refresh.
//
// The DOM-free brain (R1) never touches storage itself; an unconfigured store makes
// reads null and writes no-ops, so the flow degrades to non-persistent, never crashes.
import { useCallback, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import type { SessionDraftStore } from './guided-draft.ts'

// A LOOSE schema — an in-progress concept is any string, including empty. This
// guards STRUCTURE only, when reading back a possibly-corrupt or foreign payload;
// the submit-time min-length floor lives on the screen, not on a scratch draft.
const WorldConceptDraftSchema = z.object({ concept: z.string() })

/** The one key — the create flow has no campaign id yet (that is what it is about
 *  to make), so there is exactly one in-progress world concept per browser. */
export const WORLD_CONCEPT_DRAFT_KEY = 'mythrun_world_concept_draft'

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Read the persisted concept; null when the store is unconfigured, the key is
 *  absent, or the payload is corrupt/foreign. Never throws. */
export function readWorldConceptDraft(store: SessionDraftStore | null): string | null {
  const raw = store?.get(WORLD_CONCEPT_DRAFT_KEY) ?? null
  if (raw === null) return null
  const parsed = WorldConceptDraftSchema.safeParse(safeParseJson(raw))
  return parsed.success ? parsed.data.concept : null
}

/** Persist the concept as typed. No-op when the store is unconfigured. */
export function writeWorldConceptDraft(store: SessionDraftStore | null, concept: string): void {
  store?.set(WORLD_CONCEPT_DRAFT_KEY, JSON.stringify({ concept }))
}

/** Drop the persisted concept — called once the campaign is actually CREATED, the
 *  same moment the guided picks are dropped. A rejection or a switch to the guided
 *  path deliberately does NOT clear it: those are exactly the returns where the
 *  player's words must survive. No-op when the store is unconfigured. */
export function clearWorldConceptDraft(store: SessionDraftStore | null): void {
  store?.remove(WORLD_CONCEPT_DRAFT_KEY)
}

/** The route-facing handle: a mount-once snapshot the field seeds from, plus stable
 *  write/clear actions. */
export interface WorldConceptDraftHandle {
  /** The concept as read ONCE at mount — what the freeform field seeds from (no
   *  async prefill flash, no re-render churn). Empty when nothing is persisted. */
  readonly initial: string
  /** Persist the concept as typed. */
  readonly update: (concept: string) => void
  /** Drop the persisted concept (created-campaign only). */
  readonly clear: () => void
}

/** Bind the draft store to the create flow. `initial` is read once at mount;
 *  `update`/`clear` are stable and always target the latest store identity, so a
 *  re-render handing a fresh store object never tears anything down. */
export function useWorldConceptDraft(store: SessionDraftStore | null): WorldConceptDraftHandle {
  const storeRef = useRef(store)
  storeRef.current = store
  const [initial] = useState<string>(() => readWorldConceptDraft(store) ?? '')
  const update = useCallback((concept: string) => {
    writeWorldConceptDraft(storeRef.current, concept)
  }, [])
  const clear = useCallback(() => {
    clearWorldConceptDraft(storeRef.current)
  }, [])
  return useMemo(() => ({ initial, update, clear }), [initial, update, clear])
}
