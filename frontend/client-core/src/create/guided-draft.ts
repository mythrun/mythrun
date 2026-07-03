// The guided-create DRAFT seam (MYT-89 spec §11, pre-commit refresh-survival):
// the three in-progress media-picks + the current step, persisted so a reload of
// the create flow re-prefills what the player had typed. The DOM-free client
// brain (R1) never touches `sessionStorage` directly — it reaches persistence
// through the injected `SessionDraftStore` port, wired once at boot from the web
// shell (sessionStorage-backed) exactly like the OAuth state store. When no store
// is configured (a native shell before it wires one, or a test harness), reads
// yield null and writes/clears no-op — the create flow degrades to
// non-persistent, never crashes.
import { z } from 'zod'

/**
 * A platform-capability port (R1): synchronous string get/set/remove keyed by an
 * opaque draft key. The web impl (sessionStorage) lives in @mythrun/web under
 * src/platform/web/**; a native shell can satisfy the same surface later. Sync
 * because a local UI draft is small and read on mount (no async prefill flash).
 */
export interface SessionDraftStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/** One in-progress pick — partial by construction (empty until the player types). */
export interface GuidedPickDraft {
  title: string
  whyILikeIt: string
}

/** The persisted guided-create draft: exactly three picks + the active step. */
export interface GuidedDraft {
  picks: [GuidedPickDraft, GuidedPickDraft, GuidedPickDraft]
  step: 1 | 2 | 3
}

// A LOOSE draft schema — unlike the wire `SynthesizerPick` (min-length bounds),
// an in-progress pick is any string (including empty), so this only guards the
// STRUCTURE when reading back a possibly-corrupt/foreign payload.
const PickDraftSchema = z.object({ title: z.string(), whyILikeIt: z.string() })
const GuidedDraftSchema = z.object({
  picks: z.tuple([PickDraftSchema, PickDraftSchema, PickDraftSchema]),
  step: z.union([z.literal(1), z.literal(2), z.literal(3)]),
})

const DRAFT_KEY = 'mythrun_guided_draft'

// Configure-once injected store (mirrors configureOAuth / configureTokenRefresh):
// the web bootstrap wires it; absent (native-not-yet / tests) → graceful no-op.
let store: SessionDraftStore | null = null

export function configureGuidedDraft(nextStore: SessionDraftStore | null): void {
  store = nextStore
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Read the persisted draft; null when unconfigured, absent, or corrupt. */
export function readGuidedDraft(): GuidedDraft | null {
  const raw = store?.get(DRAFT_KEY) ?? null
  if (raw === null) return null
  const parsed = GuidedDraftSchema.safeParse(safeParseJson(raw))
  return parsed.success ? parsed.data : null
}

/** Persist the draft (no-op when unconfigured). */
export function writeGuidedDraft(draft: GuidedDraft): void {
  store?.set(DRAFT_KEY, JSON.stringify(draft))
}

/** Drop the persisted draft — called once the picks are committed (no-op when unconfigured). */
export function clearGuidedDraft(): void {
  store?.remove(DRAFT_KEY)
}
