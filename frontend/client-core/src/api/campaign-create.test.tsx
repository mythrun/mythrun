import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type {
  SynthesizerPick,
  ConceptRejection,
  CreateCampaignRequest,
} from '@mythrun/contract/rest'
import type { ApiContext } from './endpoint.ts'
import { HttpError } from './errors.ts'
import { synthesizePreview, reworkPreview, createCampaign } from './campaign-create.ts'

// The imperative campaign-create seam (Phase B calls ONLY these, never fetch).
// These drive the real `defineEndpoint` transport through MSW: a happy path
// asserts the WIRE body the endpoint sent + the parsed response, and the typed
// error paths assert the contract `code`/`body` surface as an `HttpError` the
// create UI branches on (concept_rejected / rework_exhausted) — no swallowing,
// no remapping in this layer.

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

const picks: SynthesizerPick[] = [
  { title: 'Princess Mononoke', whyILikeIt: 'The forest feels alive and morally grey.' },
  { title: 'Disco Elysium', whyILikeIt: 'Interiority and a wounded, funny world.' },
  { title: 'Annihilation', whyILikeIt: 'Beautiful, wrong, and quietly terrifying.' },
]

describe('synthesizePreview', () => {
  it('posts {picks} and resolves {previewId, title, concept}', async () => {
    let seenBody: unknown
    server.use(
      http.post(`${BASE_URL}/api/campaigns/synthesize-preview`, async ({ request }) => {
        seenBody = await request.json()
        return HttpResponse.json(
          { previewId: 'pv-1', title: 'The Drowned Archive', concept: 'A drowned archive.' },
          { status: 201 },
        )
      }),
    )

    await expect(synthesizePreview(testCtx, { picks })).resolves.toEqual({
      previewId: 'pv-1',
      // myth-z3icr: the world's name rides the proposal so the page can
      // headline it instead of mining it out of the prose.
      title: 'The Drowned Archive',
      concept: 'A drowned archive.',
    })
    expect(seenBody).toEqual({ picks })
  })

  // myth-6t06f: the freeform path buys the same proposal with its own concept.
  it('posts {concept} for a freeform proposal', async () => {
    let seenBody: unknown
    server.use(
      http.post(`${BASE_URL}/api/campaigns/synthesize-preview`, async ({ request }) => {
        seenBody = await request.json()
        return HttpResponse.json(
          { previewId: 'pv-2', title: 'The Ninth Tide', concept: 'A drowned harbour town.' },
          { status: 201 },
        )
      }),
    )
    const concept = 'A drowned harbour town where the salvage guilds fight over the tide.'

    await expect(synthesizePreview(testCtx, { concept })).resolves.toMatchObject({
      previewId: 'pv-2',
      title: 'The Ninth Tide',
    })
    expect(seenBody).toEqual({ concept })
  })

  it('surfaces a 422 as HttpError.code==="concept_rejected" with .body.synthesizedConcept', async () => {
    const rejection: ConceptRejection = {
      code: 'concept_rejected',
      reason: 'clone_intent',
      rejectionMessage: 'This reads as a direct clone of an existing IP.',
      synthesizedConcept: 'A neon city where memories are currency.',
    }
    server.use(
      http.post(`${BASE_URL}/api/campaigns/synthesize-preview`, () =>
        HttpResponse.json(rejection, { status: 422 }),
      ),
    )

    await expect(synthesizePreview(testCtx, { picks })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof HttpError &&
        e.status === 422 &&
        e.code === 'concept_rejected' &&
        (e.body as ConceptRejection).synthesizedConcept === 'A neon city where memories are currency.',
    )
  })
})

describe('reworkPreview', () => {
  it('posts {change} to the :previewId path and resolves {previewId, title, concept}', async () => {
    let seenBody: unknown
    server.use(
      http.post(`${BASE_URL}/api/campaigns/preview/pv-9/rework`, async ({ request }) => {
        seenBody = await request.json()
        return HttpResponse.json({
          previewId: 'pv-9',
          title: 'The Rainier Coast',
          concept: 'Now with more rain.',
        })
      }),
    )

    await expect(reworkPreview(testCtx, 'pv-9', { change: 'Make it rainier.' })).resolves.toEqual({
      previewId: 'pv-9',
      // A revision can rename the world, so the title rides the rework too.
      title: 'The Rainier Coast',
      concept: 'Now with more rain.',
    })
    // The previewId travels in the PATH only — the body is exactly the rework note.
    expect(seenBody).toEqual({ change: 'Make it rainier.' })
  })

  it('surfaces a 409 as HttpError.code==="rework_exhausted"', async () => {
    server.use(
      http.post(`${BASE_URL}/api/campaigns/preview/pv-9/rework`, () =>
        HttpResponse.json({ code: 'rework_exhausted' }, { status: 409 }),
      ),
    )

    await expect(reworkPreview(testCtx, 'pv-9', { change: 'Again.' })).rejects.toSatisfy(
      (e: unknown) => e instanceof HttpError && e.status === 409 && e.code === 'rework_exhausted',
    )
  })
})

describe('createCampaign', () => {
  it('posts the WRAPPED guided body and resolves {campaignId}', async () => {
    let seenBody: unknown
    const body: CreateCampaignRequest = {
      world: { kind: 'new', source: { mode: 'guided', previewId: 'pv-9' } },
    }
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, async ({ request }) => {
        seenBody = await request.json()
        return HttpResponse.json({ campaignId: 'cmp-1' }, { status: 201 })
      }),
    )

    await expect(createCampaign(testCtx, body)).resolves.toEqual({ campaignId: 'cmp-1' })
    expect(seenBody).toEqual(body)
  })

  it('posts the WRAPPED freeform body (with devBypassAccessFilter) verbatim', async () => {
    let seenBody: unknown
    const body: CreateCampaignRequest = {
      world: {
        kind: 'new',
        source: { mode: 'freeform', concept: 'A tidal city built on the bones of a leviathan.' },
      },
      devBypassAccessFilter: true,
    }
    server.use(
      http.post(`${BASE_URL}/api/campaigns`, async ({ request }) => {
        seenBody = await request.json()
        return HttpResponse.json({ campaignId: 'cmp-2' }, { status: 201 })
      }),
    )

    await expect(createCampaign(testCtx, body)).resolves.toEqual({ campaignId: 'cmp-2' })
    expect(seenBody).toEqual(body)
  })
})
