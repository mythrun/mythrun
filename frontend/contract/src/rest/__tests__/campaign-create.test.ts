import { describe, it, expect } from 'vitest'
import {
  SynthesizerPickSchema,
  SynthesizePreviewRequestSchema,
  SynthesizePreviewResponseSchema,
  ReworkRequestSchema,
  ReworkResponseSchema,
  ConceptRejectionSchema,
  CreateCampaignRequestSchema,
  CreateCampaignResponseSchema,
  GATE_REASONS,
} from '../index.js'

// A single valid pick reused across the request builders below.
const pick = { title: 'Disco Elysium', whyILikeIt: 'Interiority over combat; melancholy and wit.' }

describe('SynthesizerPickSchema', () => {
  it('parses a valid pick', () => {
    expect(SynthesizerPickSchema.parse(pick)).toEqual(pick)
  })

  it('rejects an empty title and an over-200 title', () => {
    expect(() => SynthesizerPickSchema.parse({ ...pick, title: '' })).toThrow()
    expect(() => SynthesizerPickSchema.parse({ ...pick, title: 'x'.repeat(201) })).toThrow()
  })

  it('rejects an empty whyILikeIt and an over-800 whyILikeIt', () => {
    expect(() => SynthesizerPickSchema.parse({ ...pick, whyILikeIt: '' })).toThrow()
    expect(() => SynthesizerPickSchema.parse({ ...pick, whyILikeIt: 'x'.repeat(801) })).toThrow()
  })
})

describe('SynthesizePreviewRequestSchema', () => {
  it('parses a brainstorm request with exactly 3 picks', () => {
    const parsed = SynthesizePreviewRequestSchema.parse({ picks: [pick, pick, pick] })
    expect(parsed).toEqual({ picks: [pick, pick, pick] })
  })

  it('rejects a 2-pick and a 4-pick array (length is fixed at 3)', () => {
    expect(() => SynthesizePreviewRequestSchema.parse({ picks: [pick, pick] })).toThrow()
    expect(() => SynthesizePreviewRequestSchema.parse({ picks: [pick, pick, pick, pick] })).toThrow()
  })

  // myth-6t06f: the freeform path buys the same proposal with its own concept
  // text. Bounds mirror the create route's freeform source (20..4000).
  it('parses a freeform request carrying the concept', () => {
    const concept = 'A drowned harbour town of salvage guilds.'
    expect(SynthesizePreviewRequestSchema.parse({ concept })).toEqual({ concept })
  })

  it('rejects a concept under the 20-char floor and over the 4000-char cap', () => {
    expect(() => SynthesizePreviewRequestSchema.parse({ concept: 'too short' })).toThrow()
    expect(() => SynthesizePreviewRequestSchema.parse({ concept: 'x'.repeat(4001) })).toThrow()
  })

  it('rejects a body carrying neither picks nor a concept', () => {
    expect(() => SynthesizePreviewRequestSchema.parse({})).toThrow()
  })
})

describe('SynthesizePreviewResponseSchema', () => {
  it('parses { previewId, title, concept }', () => {
    const body = { previewId: 'p1', title: 'The Low Water', concept: 'A drowned city.' }
    expect(SynthesizePreviewResponseSchema.parse(body)).toEqual(body)
  })

  it('rejects a missing concept', () => {
    expect(() =>
      SynthesizePreviewResponseSchema.parse({ previewId: 'p1', title: 'The Low Water' }),
    ).toThrow()
  })

  // myth-z3icr: the proposal page headlines the world's name, so a body without
  // one is a contract break, not a soft degrade.
  it('rejects a missing title', () => {
    expect(() =>
      SynthesizePreviewResponseSchema.parse({ previewId: 'p1', concept: 'A drowned city.' }),
    ).toThrow()
  })
})

describe('ReworkRequestSchema', () => {
  it('parses a valid single-change note', () => {
    expect(ReworkRequestSchema.parse({ change: 'Make it colder.' }).change).toBe('Make it colder.')
  })

  it('rejects an empty change and an over-800 change', () => {
    expect(() => ReworkRequestSchema.parse({ change: '' })).toThrow()
    expect(() => ReworkRequestSchema.parse({ change: 'x'.repeat(801) })).toThrow()
  })
})

describe('ReworkResponseSchema', () => {
  it('parses { previewId, title, concept }', () => {
    const body = { previewId: 'p1', title: 'The Colder Coast', concept: 'A colder city.' }
    expect(ReworkResponseSchema.parse(body)).toEqual(body)
  })

  // A revision can rename the world, so the title rides the rework 200 too.
  it('rejects a missing title', () => {
    expect(() => ReworkResponseSchema.parse({ previewId: 'p1', concept: 'A colder city.' })).toThrow()
  })
})

describe('ConceptRejectionSchema', () => {
  it('parses a guided rejection (synthesizedConcept present)', () => {
    const parsed = ConceptRejectionSchema.parse({
      code: 'concept_rejected',
      reason: 'inappropriate',
      rejectionMessage: 'That concept crosses a line.',
      synthesizedConcept: 'A synthesized concept the user can inspect.',
    })
    expect(parsed.code).toBe('concept_rejected')
    expect(parsed.reason).toBe('inappropriate')
  })

  it('parses a freeform rejection (synthesizedConcept absent, rejectionMessage null)', () => {
    const parsed = ConceptRejectionSchema.parse({
      code: 'concept_rejected',
      reason: 'clone_intent',
      rejectionMessage: null,
    })
    expect(parsed.synthesizedConcept).toBeUndefined()
    expect(parsed.rejectionMessage).toBeNull()
  })

  it('accepts every gate reason', () => {
    for (const reason of GATE_REASONS) {
      const parsed = ConceptRejectionSchema.parse({ code: 'concept_rejected', reason, rejectionMessage: null })
      expect(parsed.reason).toBe(reason)
    }
  })

  it('rejects a wrong code literal and an unknown reason', () => {
    expect(() =>
      ConceptRejectionSchema.parse({ code: 'nope', reason: 'inappropriate', rejectionMessage: null }),
    ).toThrow()
    expect(() =>
      ConceptRejectionSchema.parse({ code: 'concept_rejected', reason: 'made_up', rejectionMessage: null }),
    ).toThrow()
  })
})

describe('CreateCampaignRequestSchema', () => {
  it('parses a freeform request with a 20..4000 char concept', () => {
    const parsed = CreateCampaignRequestSchema.parse({
      world: { kind: 'new', source: { mode: 'freeform', concept: 'x'.repeat(20) } },
    })
    expect(parsed.world.source.mode).toBe('freeform')
  })

  it('rejects a 19-char freeform concept and an over-4000 concept', () => {
    expect(() =>
      CreateCampaignRequestSchema.parse({
        world: { kind: 'new', source: { mode: 'freeform', concept: 'x'.repeat(19) } },
      }),
    ).toThrow()
    expect(() =>
      CreateCampaignRequestSchema.parse({
        world: { kind: 'new', source: { mode: 'freeform', concept: 'x'.repeat(4001) } },
      }),
    ).toThrow()
  })

  it('parses a guided request with a previewId', () => {
    const parsed = CreateCampaignRequestSchema.parse({
      world: { kind: 'new', source: { mode: 'guided', previewId: 'p1' } },
    })
    expect(parsed.world.source.mode).toBe('guided')
    if (parsed.world.source.mode === 'guided') {
      expect(parsed.world.source.previewId).toBe('p1')
    }
  })

  it('accepts the optional dev-only devBypassAccessFilter flag', () => {
    const parsed = CreateCampaignRequestSchema.parse({
      world: { kind: 'new', source: { mode: 'guided', previewId: 'p1' } },
      devBypassAccessFilter: true,
    })
    expect(parsed.devBypassAccessFilter).toBe(true)
  })

  it('rejects a guided arm carrying concept instead of previewId (discriminated union)', () => {
    expect(() =>
      CreateCampaignRequestSchema.parse({
        world: { kind: 'new', source: { mode: 'guided', concept: 'a'.repeat(30) } },
      }),
    ).toThrow()
  })

  it('rejects an unknown source mode and an unknown kind', () => {
    expect(() =>
      CreateCampaignRequestSchema.parse({
        world: { kind: 'new', source: { mode: 'assisted', previewId: 'p1' } },
      }),
    ).toThrow()
    expect(() =>
      CreateCampaignRequestSchema.parse({
        world: { kind: 'existing', source: { mode: 'guided', previewId: 'p1' } },
      }),
    ).toThrow()
  })
})

describe('CreateCampaignResponseSchema', () => {
  it('parses { campaignId }', () => {
    expect(CreateCampaignResponseSchema.parse({ campaignId: 'c1' }).campaignId).toBe('c1')
  })

  it('rejects a missing campaignId', () => {
    expect(() => CreateCampaignResponseSchema.parse({})).toThrow()
  })
})
