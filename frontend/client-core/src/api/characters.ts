import { z } from 'zod'
import { defineEndpoint, type ApiContext } from './endpoint.ts'

// The MYT-90 character-creation slice of the data layer — the R5 backend seam
// for the per-player character routes (backend/src/routes/campaign-characters.ts).
// The character-creation UI (and the D6 reveal) call ONLY these imperative
// functions, never `fetch`: each compiles to a `defineEndpoint` (method + typed
// path + Zod request/response), so the wire body is contract-validated before it
// leaves and the response is validated on arrival. Mutations in this codebase are
// imperative (no `useX`) — like `register`/`createCampaign` — so these follow
// that shape, mirroring `getStartingSituations`/`chooseStartingSituation`.
//
// On a non-2xx, `defineEndpoint` throws an `HttpError` carrying `.status`,
// `.code`, and the raw `.body`; this layer NEVER swallows or remaps it (the
// screens branch on `.code` — `concept_locked`, `not_resettable`, etc.).
//
// `getCharacter` returns the RAW backend character row + its four sub-tables
// verbatim (snake_case). The reveal's raw→CuratedSheet adaptation (SRD maps +
// B4's sheetViewModel) is a LATER task (D6), not this layer — so no reshaping,
// and no invented fields the backend does not return.
//
// `setStartingLevel` lives in its own module (`./starting-level.ts`) alongside
// this one; both are re-exported from the package barrel.

// -----------------------------------------------------------------------------
// POST /api/campaigns/:campaignId/characters — submit/update the caller's concept.
//
// The body carries BOTH `conceptText` AND `situationGroundingText` (both
// required). Bounds mirror the backend `PostCharacterBodySchema` (20..4000 /
// 20..2000), which itself mirrors the migration-016 DB CHECK — so the failure
// mode for an out-of-range value stays at the request boundary. The endpoint
// input also carries `campaignId` (for the path); the request schema strips it
// back out at serialization, so it travels in the path only.
//
// myth-4jhrk: `guidedChoices` is the guided builder's STRUCTURED picks — the
// shared wire contract with the backend's GuidedChoicesSchema
// (backend/src/llm/schemas/character-concept.ts). The guided path sends BOTH
// the flattened conceptText prose AND these picks; the backend persists the
// picks and pins the subclass end-to-end (prose alone loses it — the run-2
// "Life Domain became Grave Domain" forensics). Freeform omits the field.
// -----------------------------------------------------------------------------

// myth-gdycq: `pronouns` is a closed token set (the backend `PronounsSchema`),
// not free text — the server PINS the value over the model's echo, which only
// works against tokens it defines. It rides the structured-pick channel from
// BOTH creation paths, so "guided choices" names the channel, not the builder.
export const PRONOUN_TOKENS = ['she_her', 'he_him', 'they_them', 'name_only'] as const
export type PronounToken = (typeof PRONOUN_TOKENS)[number]

const GuidedChoicesSchema = z.object({
  class: z.string().min(1).max(60).optional(),
  subclass: z.string().min(1).max(60).optional(),
  species: z.string().min(1).max(60).optional(),
  background: z.string().min(1).max(60).optional(),
  pronouns: z.enum(PRONOUN_TOKENS).optional(),
})
export type GuidedChoicesPayload = z.infer<typeof GuidedChoicesSchema>

const SubmitCharacterBodySchema = z.object({
  conceptText: z.string().min(20).max(4000),
  situationGroundingText: z.string().min(20).max(2000),
  guidedChoices: GuidedChoicesSchema.optional(),
})
export type SubmitCharacterBody = z.infer<typeof SubmitCharacterBodySchema>

/** POST /characters 200 body — the seeded concept id + its now-`processing`
 *  status + the deterministic per-player job id. */
const SubmitCharacterResponseSchema = z.object({
  conceptId: z.string(),
  status: z.string(),
  jobId: z.string(),
})
export type SubmitCharacterResponse = z.infer<typeof SubmitCharacterResponseSchema>

const submitCharacterEndpoint = defineEndpoint<
  SubmitCharacterResponse,
  { campaignId: string } & SubmitCharacterBody
>({
  method: 'POST',
  path: (input) => `/api/campaigns/${encodeURIComponent(input.campaignId)}/characters`,
  request: SubmitCharacterBodySchema,
  response: SubmitCharacterResponseSchema,
})

/** Member-scoped. Submits (or re-submits a `submitted`/`failed`) concept, which
 *  kicks off the per-player pipeline. Throws `HttpError` on the gate 409s
 *  (`concept_locked`, `world_not_complete`, `starting_situation_not_chosen`,
 *  `starting_level_not_chosen`) / 400 `bad_body`. */
export function submitCharacter(
  ctx: ApiContext,
  campaignId: string,
  body: SubmitCharacterBody,
): Promise<SubmitCharacterResponse> {
  return submitCharacterEndpoint({ campaignId, ...body }, ctx)
}

// -----------------------------------------------------------------------------
// GET /api/campaigns/:campaignId/characters — the party roster.
//
// One row per member; `characterId` is present ONLY after a PC is persisted
// (the backend omits the key rather than serializing null), so it is optional.
// -----------------------------------------------------------------------------

const PartyMemberSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  conceptStatus: z.string(),
  characterId: z.string().optional(),
})

const PartyRosterSchema = z.object({
  members: z.array(PartyMemberSchema),
})
export type PartyRoster = z.infer<typeof PartyRosterSchema>

const getCharactersEndpoint = defineEndpoint<PartyRoster, { campaignId: string }>({
  method: 'GET',
  path: (input) => `/api/campaigns/${encodeURIComponent(input.campaignId)}/characters`,
  response: PartyRosterSchema,
})

/** Member-visible. Fetches the campaign's party roster (member → concept status
 *  → persisted PC id). */
export function getCharacters(ctx: ApiContext, campaignId: string): Promise<PartyRoster> {
  return getCharactersEndpoint({ campaignId }, ctx)
}

// -----------------------------------------------------------------------------
// GET /api/campaigns/:campaignId/characters/:charId — one PC's full read.
//
// The RAW backend shape: the `characters` row (snake_case, Dates serialized to
// ISO strings) + the four sub-tables projected to their meaningful columns. NOT
// reshaped into a view-model — D6 adapts raw→CuratedSheet with the SRD maps +
// B4's sheetViewModel. `entity_id` is nullable on the wire (null until the PC's
// world entity is linked at integration).
// -----------------------------------------------------------------------------

const CharacterRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  entity_id: z.string().nullable(),
  name: z.string(),
  level: z.number(),
  class: z.string(),
  species: z.string(),
  background: z.string(),
  str: z.number(),
  dex: z.number(),
  con: z.number(),
  int: z.number(),
  wis: z.number(),
  cha: z.number(),
  hit_points: z.number(),
  max_hit_points: z.number(),
  armor_class: z.number(),
  proficiency_bonus: z.number(),
  gold: z.number(),
  hit_die: z.number(),
  hit_dice_remaining: z.number(),
  spellcasting_progression: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
})

const CharacterSkillSchema = z.object({
  skill_name: z.string(),
  proficiency_level: z.string(),
})

const CharacterFeatureSchema = z.object({
  feature_name: z.string(),
  feature_source: z.string(),
  description: z.string(),
})

const CharacterEquipmentSchema = z.object({
  item_name: z.string(),
  quantity: z.number(),
  equipped: z.boolean(),
})

const CharacterSpellSchema = z.object({
  spell_name: z.string(),
  spell_level: z.number(),
  prepared: z.boolean(),
})

// MYT-90: the character-concept narrative prose the reveal's prose panel is built
// from — the physical description, the personality sentences
// (trait/ideal/bond/flaw), and the player-authored situation-grounding text
// ("connection to the opening"). Optional on the full read (older character rows
// predate the concept projection, and a character can exist without a concept
// row), so the D6 adapter degrades to an empty prose panel when it is absent.
const CharacterConceptProseSchema = z.object({
  physical_description: z.string().nullable(),
  personality_traits: z.array(z.string()),
  ideals: z.array(z.string()),
  bonds: z.array(z.string()),
  flaws: z.array(z.string()),
  situation_grounding_text: z.string(),
})

const CharacterFullSchema = z.object({
  character: CharacterRowSchema,
  skills: z.array(CharacterSkillSchema),
  features: z.array(CharacterFeatureSchema),
  equipment: z.array(CharacterEquipmentSchema),
  spells: z.array(CharacterSpellSchema),
  concept: CharacterConceptProseSchema.optional(),
})
export type CharacterFull = z.infer<typeof CharacterFullSchema>

const getCharacterEndpoint = defineEndpoint<CharacterFull, { campaignId: string; charId: string }>({
  method: 'GET',
  path: (input) =>
    `/api/campaigns/${encodeURIComponent(input.campaignId)}/characters/${encodeURIComponent(
      input.charId,
    )}`,
  response: CharacterFullSchema,
})

/** Member-visible. Fetches one PC's full raw read. Throws `HttpError` 404
 *  `character_not_in_campaign` when the id isn't linked to this campaign. */
export function getCharacter(
  ctx: ApiContext,
  campaignId: string,
  charId: string,
): Promise<CharacterFull> {
  return getCharacterEndpoint({ campaignId, charId }, ctx)
}

// -----------------------------------------------------------------------------
// GET /api/campaigns/:campaignId/character-creation-progress — the status board.
//
// Members with a concept row land in `concepts[]` (status passed through
// verbatim); those without land in `missing[]`. `error` (JSONB) is forwarded
// as-is and present ONLY when a concept is `failed`, so it is an optional
// unknown blob the client owns the display shape of.
//
// MYT-90 D8: each concept also carries `confirmedAt` (the "This is me"
// timestamp, null until confirmed) and `characterId` (the generated PC id, null
// until the sheet exists). The character-creation routing surface keys the
// reveal→party-staging split on `confirmedAt` (so a reload in the
// completed→active window is stable) and hands `characterId` to the reveal so it
// can fetch the sheet. Both are `.nullable()` additive fields.
// -----------------------------------------------------------------------------

const ConceptProgressSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  status: z.string(),
  submittedAt: z.string(),
  // `.nullable().optional()` (not a bare `.nullable()`) so this stays a purely
  // additive change: existing typed `CharacterCreationProgress` fixtures across
  // the committed surfaces (party-staging) keep type-checking without edits. The
  // backend always emits both (null or a value), so the routing surface still
  // receives them; a legacy/absent field is read as null.
  confirmedAt: z.string().nullable().optional(),
  characterId: z.string().nullable().optional(),
  error: z.unknown().optional(),
})

const MissingMemberSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
})

const CharacterCreationProgressSchema = z.object({
  campaignId: z.string(),
  totalMembers: z.number(),
  concepts: z.array(ConceptProgressSchema),
  missing: z.array(MissingMemberSchema),
})
export type CharacterCreationProgress = z.infer<typeof CharacterCreationProgressSchema>

const getCharacterCreationProgressEndpoint = defineEndpoint<
  CharacterCreationProgress,
  { campaignId: string }
>({
  method: 'GET',
  path: (input) =>
    `/api/campaigns/${encodeURIComponent(input.campaignId)}/character-creation-progress`,
  response: CharacterCreationProgressSchema,
})

/** Member-visible. Drives the finalize confirmation ("are you sure?"). */
export function getCharacterCreationProgress(
  ctx: ApiContext,
  campaignId: string,
): Promise<CharacterCreationProgress> {
  return getCharacterCreationProgressEndpoint({ campaignId }, ctx)
}

// -----------------------------------------------------------------------------
// POST /api/campaigns/:campaignId/finalize-character-creation — owner fan-in.
//
// A 202 implies the notes are committed AND the integration job was enqueued.
// This layer never sends `pre_integration_notes`, but MUST still send an empty
// JSON `{}` body: the route parses `req.body` with `z.object(...).safeParse`, so
// a bodyless POST would 400 `bad_body`. The empty-object request schema strips
// the path-only `campaignId` back out at serialization.
// -----------------------------------------------------------------------------

const FinalizeResultSchema = z.object({
  campaignId: z.string(),
  jobId: z.string(),
})
export type FinalizeResult = z.infer<typeof FinalizeResultSchema>

const EmptyBodySchema = z.object({})

const finalizeCharacterCreationEndpoint = defineEndpoint<FinalizeResult, { campaignId: string }>({
  method: 'POST',
  path: (input) =>
    `/api/campaigns/${encodeURIComponent(input.campaignId)}/finalize-character-creation`,
  request: EmptyBodySchema,
  response: FinalizeResultSchema,
})

/** Owner-only. Triggers character integration (202). Throws `HttpError` 409
 *  (`not_in_setup`, `no_completed_concepts`) / 503 `queue_not_ready`. */
export function finalizeCharacterCreation(
  ctx: ApiContext,
  campaignId: string,
): Promise<FinalizeResult> {
  return finalizeCharacterCreationEndpoint({ campaignId }, ctx)
}

// -----------------------------------------------------------------------------
// POST /api/campaigns/:campaignId/characters/reset — "Start over" (204).
// POST /api/campaigns/:campaignId/characters/confirm — "This is me" (204).
//
// Self-scoped: any member acts on their OWN concept. Neither route reads a body,
// so no request schema; both reply 204, so the response schema is `z.void()`
// (`defineEndpoint` parses the empty 204 as `undefined`).
// -----------------------------------------------------------------------------

// `Res` (void) is inferred from `response: z.void()` — writing it as an explicit
// generic argument trips `no-invalid-void-type`; `In` is inferred from the typed
// `path` param instead.
const resetCharacterConceptEndpoint = defineEndpoint({
  method: 'POST',
  path: (input: { campaignId: string }) =>
    `/api/campaigns/${encodeURIComponent(input.campaignId)}/characters/reset`,
  response: z.void(),
})

/** Self-scoped. Flips the caller's own `completed`/`failed` concept back to
 *  resubmittable + clears the generated sheet. Throws `HttpError` 409
 *  `not_resettable` when the concept can't be unwound. */
export function resetCharacterConcept(ctx: ApiContext, campaignId: string): Promise<void> {
  return resetCharacterConceptEndpoint({ campaignId }, ctx)
}

const confirmCharacterEndpoint = defineEndpoint({
  method: 'POST',
  path: (input: { campaignId: string }) =>
    `/api/campaigns/${encodeURIComponent(input.campaignId)}/characters/confirm`,
  response: z.void(),
})

/** Self-scoped. Persists `confirmed_at` on the caller's own `completed` concept
 *  (idempotent). Throws `HttpError` 409 `not_confirmable` when nothing is
 *  confirmable. */
export function confirmCharacter(ctx: ApiContext, campaignId: string): Promise<void> {
  return confirmCharacterEndpoint({ campaignId }, ctx)
}
