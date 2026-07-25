// The CHARACTER-creation draft seam — the player's OWN written inputs (the
// freeform concept + grounding, and the guided picks), persisted so a failed
// generation, a "Start over", a reload, or any other return to the flow NEVER
// loses their words. This is the durability half of the P0 fix for "the character
// didn't take shape → Start over threw away everything I'd written."
//
// Mirrors the campaign guided-create draft (create/guided-draft.ts, MYT-89 §11):
// the DOM-free brain (R1) never touches storage directly — it reaches persistence
// through the injected `SessionDraftStore` port (the same generic get/set/remove
// capability). Unlike the campaign draft (sessionStorage, tab-scoped), the WEB
// realization for characters is localStorage-backed (see
// src/platform/web/character-draft-store.ts): character creation is a higher-
// investment surface, so the words survive a tab close / crash, not just a reload.
//
// The store is INJECTED per-route (not a configure-once global like guided-draft)
// so this seam adds no boot-file wiring and stays trivially test-isolated — each
// test hands its own fake store, no global reset between tests.
import { useCallback, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import type { SessionDraftStore } from '../create/guided-draft.ts'

export type { SessionDraftStore }

// A LOOSE schema — an in-progress draft is any partial of free strings (including
// empty). This guards STRUCTURE only, when reading back a possibly-corrupt or
// foreign payload; it never applies the wire-body min-length floors (those belong
// at submit time, not to a scratch draft). The exported types are inferred from the
// schema (one source of truth) so a read-back value assigns cleanly under
// exactOptionalPropertyTypes.
const GuidedDraftSchema = z
  .object({
    className: z.string().optional(),
    subclass: z.string().optional(),
    species: z.string().optional(),
    background: z.string().optional(),
    notes: z.string().optional(),
  })
  .partial()

const CharacterDraftSchema = z.object({
  conceptText: z.string().optional(),
  groundingText: z.string().optional(),
  // myth-gdycq: the pronoun ask is asked on BOTH paths, so it is durable at the
  // draft's top level rather than inside the guided picks. A loose string here
  // (the schema guards structure only); `toPronounChoice` narrows it on read.
  pronouns: z.string().optional(),
  guided: GuidedDraftSchema.optional(),
})

/** The player's in-progress guided picks — partial by construction (fields fill in
 *  as they advance the builder). Free strings, including empty. */
export type CharacterGuidedDraft = z.infer<typeof GuidedDraftSchema>

/** The persisted character-creation draft: the player's OWN written inputs. Every
 *  field optional — a draft captures whatever they have typed so far. */
export type CharacterDraft = z.infer<typeof CharacterDraftSchema>

const KEY_PREFIX = 'mythrun_character_draft:'

/** The per-campaign draft key. Scoped by campaign so each campaign's in-progress
 *  character keeps its own words; the player only ever creates one character per
 *  campaign, so a campaign-scoped key is exactly one draft. */
export function characterDraftKey(campaignId: string): string {
  return KEY_PREFIX + campaignId
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Read the persisted draft; null when the store is unconfigured, the key is
 *  absent, or the payload is corrupt/foreign. Never throws. */
export function readCharacterDraft(
  store: SessionDraftStore | null,
  campaignId: string,
): CharacterDraft | null {
  const raw = store?.get(characterDraftKey(campaignId)) ?? null
  if (raw === null) return null
  const parsed = CharacterDraftSchema.safeParse(safeParseJson(raw))
  return parsed.success ? parsed.data : null
}

/** Merge `patch` into the persisted draft (read-merge-write). A patch updates ONLY
 *  its own fields and never clobbers the player's OTHER in-progress field — writing
 *  the concept must not wipe the grounding they typed a moment earlier. No-op when
 *  the store is unconfigured. */
export function writeCharacterDraft(
  store: SessionDraftStore | null,
  campaignId: string,
  patch: CharacterDraft,
): void {
  if (store === null) return
  const current = readCharacterDraft(store, campaignId) ?? {}
  const mergedGuided: CharacterGuidedDraft = { ...current.guided, ...patch.guided }
  const next: CharacterDraft = { ...current, ...patch }
  if (Object.keys(mergedGuided).length > 0) {
    next.guided = mergedGuided
  } else {
    delete next.guided
  }
  store.set(characterDraftKey(campaignId), JSON.stringify(next))
}

/** Drop the persisted draft — called once the character is CONFIRMED created (the
 *  concept reaches 'integrated'). A "Start over" or a failure deliberately does NOT
 *  clear it: those are exactly the returns where the player's words must survive.
 *  No-op when the store is unconfigured. */
export function clearCharacterDraft(
  store: SessionDraftStore | null,
  campaignId: string,
): void {
  store?.remove(characterDraftKey(campaignId))
}

/** The route-facing handle: a mount-once snapshot the fields seed from, plus stable
 *  merge/clear writers. */
export interface CharacterDraftHandle {
  /** The draft as read ONCE at mount — a stable snapshot the freeform/guided fields
   *  seed their local state from (no async prefill flash, no re-render churn). */
  readonly initial: CharacterDraft
  /** Merge a patch into the persisted draft (read-merge-write). */
  readonly update: (patch: CharacterDraft) => void
  /** Drop the persisted draft (confirmed-creation only). */
  readonly clear: () => void
}

/** Bind the draft store to a campaign for a route. `initial` is read once at mount;
 *  `update`/`clear` are stable and always target the latest store identity, so a
 *  re-render handing a fresh store object never tears anything down. */
export function useCharacterDraft(
  store: SessionDraftStore | null,
  campaignId: string,
): CharacterDraftHandle {
  const storeRef = useRef(store)
  storeRef.current = store
  const [initial] = useState<CharacterDraft>(() => readCharacterDraft(store, campaignId) ?? {})
  const update = useCallback(
    (patch: CharacterDraft) => {
      writeCharacterDraft(storeRef.current, campaignId, patch)
    },
    [campaignId],
  )
  const clear = useCallback(() => {
    clearCharacterDraft(storeRef.current, campaignId)
  }, [campaignId])
  return useMemo(() => ({ initial, update, clear }), [initial, update, clear])
}
