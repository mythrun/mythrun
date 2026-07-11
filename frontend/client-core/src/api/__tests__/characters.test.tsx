import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ApiContext } from '../endpoint.ts'
import { HttpError, isHttpError } from '../errors.ts'
import {
  confirmCharacter,
  finalizeCharacterCreation,
  getCharacter,
  getCharacterCreationProgress,
  getCharacters,
  resetCharacterConcept,
  submitCharacter,
} from '../characters.ts'
import { setStartingLevel } from '../starting-level.ts'

// The MYT-90 B2 character-API layer: each slice is a `defineEndpoint` (method +
// typed path + Zod request/response), so the wire body is contract-validated
// before it leaves and the response is validated on arrival. These tests drive
// the real endpoint through MSW: a valid payload resolves the parsed shape, and
// (representatively) a non-2xx surfaces a typed `HttpError`. `submitCharacter`
// carries BOTH `conceptText` AND `situationGroundingText`; `getCharacter` parses
// the RAW backend character row + its four sub-tables verbatim (the reveal's
// view-model shaping is D6, not here).

const BASE_URL = 'http://api.test'
const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

const testCtx: ApiContext = {
  baseUrl: BASE_URL,
  getAuthHeaders: () => Promise.resolve({}),
}

describe('submitCharacter', () => {
  it('posts BOTH conceptText and situationGroundingText and resolves the processing body', async () => {
    let posted: unknown
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-1/characters`, async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json({ conceptId: 'con-1', status: 'processing', jobId: 'cc-c-1-u-1' })
      }),
    )
    await expect(
      submitCharacter(testCtx, 'c-1', {
        conceptText: 'A wandering hedge-witch who talks to crows and owes a debt.',
        situationGroundingText: 'I came to the reach chasing a rumour of my sister.',
      }),
    ).resolves.toEqual({ conceptId: 'con-1', status: 'processing', jobId: 'cc-c-1-u-1' })
    // Both texts ride the body; the campaignId travels in the path, not the body.
    expect(posted).toEqual({
      conceptText: 'A wandering hedge-witch who talks to crows and owes a debt.',
      situationGroundingText: 'I came to the reach chasing a rumour of my sister.',
    })
  })

  it('throws a typed HttpError 409 concept_locked once the concept is locked', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-1/characters`, () =>
        HttpResponse.json({ code: 'concept_locked' }, { status: 409 }),
      ),
    )
    const error = await submitCharacter(testCtx, 'c-1', {
      conceptText: 'A wandering hedge-witch who talks to crows and owes a debt.',
      situationGroundingText: 'I came to the reach chasing a rumour of my sister.',
    }).catch((e: unknown) => e)
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe('concept_locked')
  })
})

describe('getCharacters', () => {
  it('parses the party roster, keeping characterId only when present', async () => {
    const roster = {
      members: [
        { userId: 'u-1', displayName: 'Ada', conceptStatus: 'completed', characterId: 'char-1' },
        { userId: 'u-2', displayName: 'Ben', conceptStatus: 'none' },
      ],
    }
    server.use(
      http.get(`${BASE_URL}/api/campaigns/c-1/characters`, () => HttpResponse.json(roster)),
    )
    await expect(getCharacters(testCtx, 'c-1')).resolves.toEqual(roster)
  })
})

describe('getCharacter', () => {
  const fullCharacter = {
    character: {
      id: 'char-1',
      user_id: 'u-1',
      entity_id: null,
      name: 'Bramble',
      level: 3,
      class: 'Druid',
      species: 'Halfling',
      background: 'Hermit',
      str: 8,
      dex: 14,
      con: 12,
      int: 10,
      wis: 16,
      cha: 11,
      hit_points: 21,
      max_hit_points: 21,
      armor_class: 13,
      proficiency_bonus: 2,
      gold: 15,
      hit_die: 8,
      hit_dice_remaining: 3,
      spellcasting_progression: 'full',
      created_at: '2026-07-01T10:00:00.000Z',
      updated_at: '2026-07-01T10:00:00.000Z',
    },
    skills: [{ skill_name: 'Perception', proficiency_level: 'proficient' }],
    features: [
      { feature_name: 'Wild Shape', feature_source: 'class', description: 'Turn into a beast.' },
    ],
    equipment: [{ item_name: 'Quarterstaff', quantity: 1, equipped: true }],
    spells: [{ spell_name: 'Entangle', spell_level: 1, prepared: true }],
  }

  it('parses the RAW backend character row + its four sub-tables verbatim', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/c-1/characters/char-1`, () =>
        HttpResponse.json(fullCharacter),
      ),
    )
    await expect(getCharacter(testCtx, 'c-1', 'char-1')).resolves.toEqual(fullCharacter)
  })

  it('throws a typed HttpError 404 when the character is not in the campaign', async () => {
    server.use(
      http.get(`${BASE_URL}/api/campaigns/c-1/characters/char-9`, () =>
        HttpResponse.json({ code: 'character_not_in_campaign' }, { status: 404 }),
      ),
    )
    const error = await getCharacter(testCtx, 'c-1', 'char-9').catch((e: unknown) => e)
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(404)
    expect((error as HttpError).code).toBe('character_not_in_campaign')
  })
})

describe('getCharacterCreationProgress', () => {
  it('parses concepts (with the optional error blob) and the missing list', async () => {
    const progress = {
      campaignId: 'c-1',
      totalMembers: 3,
      concepts: [
        { userId: 'u-1', displayName: 'Ada', status: 'completed', submittedAt: '2026-07-01T10:00:00.000Z' },
        {
          userId: 'u-2',
          displayName: 'Ben',
          status: 'failed',
          submittedAt: '2026-07-01T10:05:00.000Z',
          error: { message: 'the prep stage rejected the concept' },
        },
      ],
      missing: [{ userId: 'u-3', displayName: 'Cy' }],
    }
    server.use(
      http.get(`${BASE_URL}/api/campaigns/c-1/character-creation-progress`, () =>
        HttpResponse.json(progress),
      ),
    )
    await expect(getCharacterCreationProgress(testCtx, 'c-1')).resolves.toEqual(progress)
  })
})

describe('finalizeCharacterCreation', () => {
  it('posts an empty JSON body and resolves the 202 fan-in body', async () => {
    let posted: unknown
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-1/finalize-character-creation`, async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json({ campaignId: 'c-1', jobId: 'ci-c-1' }, { status: 202 })
      }),
    )
    await expect(finalizeCharacterCreation(testCtx, 'c-1')).resolves.toEqual({
      campaignId: 'c-1',
      jobId: 'ci-c-1',
    })
    // `{}` (not a bodyless POST) so the route's z.object body parse succeeds; the
    // campaignId rides the path, never the body.
    expect(posted).toEqual({})
  })

  it('throws a typed HttpError 409 no_completed_concepts', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-1/finalize-character-creation`, () =>
        HttpResponse.json({ code: 'no_completed_concepts' }, { status: 409 }),
      ),
    )
    const error = await finalizeCharacterCreation(testCtx, 'c-1').catch((e: unknown) => e)
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe('no_completed_concepts')
  })
})

describe('resetCharacterConcept', () => {
  it('resolves undefined on a 204', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-1/characters/reset`, () => new HttpResponse(null, { status: 204 })),
    )
    await expect(resetCharacterConcept(testCtx, 'c-1')).resolves.toBeUndefined()
  })

  it('throws a typed HttpError 409 not_resettable', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-1/characters/reset`, () =>
        HttpResponse.json({ code: 'not_resettable' }, { status: 409 }),
      ),
    )
    const error = await resetCharacterConcept(testCtx, 'c-1').catch((e: unknown) => e)
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe('not_resettable')
  })
})

describe('confirmCharacter', () => {
  it('resolves undefined on a 204', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-1/characters/confirm`, () => new HttpResponse(null, { status: 204 })),
    )
    await expect(confirmCharacter(testCtx, 'c-1')).resolves.toBeUndefined()
  })

  it('throws a typed HttpError 409 not_confirmable', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-1/characters/confirm`, () =>
        HttpResponse.json({ code: 'not_confirmable' }, { status: 409 }),
      ),
    )
    const error = await confirmCharacter(testCtx, 'c-1').catch((e: unknown) => e)
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe('not_confirmable')
  })
})

describe('setStartingLevel', () => {
  it('posts the chosen level as the body and resolves undefined on a 204', async () => {
    let posted: unknown
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-1/starting-level`, async ({ request }) => {
        posted = await request.json()
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await expect(setStartingLevel(testCtx, 'c-1', 3)).resolves.toBeUndefined()
    // Only `{ level }` rides the body — the campaignId travels in the path.
    expect(posted).toEqual({ level: 3 })
  })

  it('throws a typed HttpError 409 level_locked', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/c-1/starting-level`, () =>
        HttpResponse.json({ code: 'level_locked' }, { status: 409 }),
      ),
    )
    const error = await setStartingLevel(testCtx, 'c-1', 2).catch((e: unknown) => e)
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe('level_locked')
  })
})
