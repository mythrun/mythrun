// backend/src/llm/schemas/__tests__/character-integration.test.ts
//
// MYT-54 T7: whole-party character-integration schema. The Opus pass emits
// one structured response covering every PC's entity + facts + relationships,
// including PC↔PC edges. PC↔PC uses `targetUserId`; other targetKinds use
// `targetId` (UUID). Discriminated union on `targetKind` enforces the split.

import { describe, expect, it } from 'vitest'
import { IntegrationResultSchema } from '../character-integration.js'

const userIdA = '0190a000-0000-7000-8000-000000000001'
const userIdB = '0190a000-0000-7000-8000-000000000002'
const npcEntityId = '0190a000-0000-7000-8000-000000000010'
const locationEntityId = '0190a000-0000-7000-8000-000000000011'

const validFact = {
  content: 'Bran was apprenticed at the Bone Sept in his twelfth year.',
  tags: ['backstory'],
  aboutEntityId: null,
}

const validPcEntity = {
  name: 'Bran of the Hollow',
  proseKernel:
    'A road-weary cleric arriving at the tavern with a tin ladle, a faded sept-mark on the back of his left hand, and a quiet that comes from twenty years of listening for a voice that no longer answers at the altar.',
}

const minimalPayload = {
  characters: [
    {
      userId: userIdA,
      displayName: 'Miklos',
      entity: validPcEntity,
      facts: [validFact],
      relationships: [],
    },
  ],
}

describe('IntegrationResultSchema', () => {
  it('accepts a minimal valid payload (1 PC, 1 fact, 0 relationships)', () => {
    expect(IntegrationResultSchema.safeParse(minimalPayload).success).toBe(true)
  })

  it('rejects facts with content shorter than 20 chars', () => {
    const bad = {
      characters: [
        {
          ...minimalPayload.characters[0],
          facts: [{ ...validFact, content: 'too short' }],
        },
      ],
    }
    expect(IntegrationResultSchema.safeParse(bad).success).toBe(false)
  })

  it('accepts a PC↔PC relationship via targetUserId', () => {
    const payload = {
      characters: [
        {
          ...minimalPayload.characters[0],
          relationships: [
            {
              targetKind: 'pc' as const,
              targetUserId: userIdB,
              type: 'old_friend_of',
              description:
                'They met in the watch barracks and have traded letters ever since the campaign ended.',
            },
          ],
        },
      ],
    }
    expect(IntegrationResultSchema.safeParse(payload).success).toBe(true)
  })

  it('accepts a PC↔NPC relationship via targetId', () => {
    const payload = {
      characters: [
        {
          ...minimalPayload.characters[0],
          relationships: [
            {
              targetKind: 'npc' as const,
              targetId: npcEntityId,
              type: 'owes_debt_to',
              description:
                'A long-running debt going back to a roadside loan three years ago.',
            },
          ],
        },
      ],
    }
    expect(IntegrationResultSchema.safeParse(payload).success).toBe(true)
  })

  it('accepts a PC↔location relationship via targetId', () => {
    const payload = {
      characters: [
        {
          ...minimalPayload.characters[0],
          relationships: [
            {
              targetKind: 'location' as const,
              targetId: locationEntityId,
              type: 'grew_up_in',
              description:
                'The hollow where the sept stood; he has not been back since the fire took it.',
            },
          ],
        },
      ],
    }
    expect(IntegrationResultSchema.safeParse(payload).success).toBe(true)
  })

  it('rejects a PC-arm relationship with targetId instead of targetUserId', () => {
    const payload = {
      characters: [
        {
          ...minimalPayload.characters[0],
          relationships: [
            {
              targetKind: 'pc' as const,
              targetId: userIdB,
              type: 'old_friend_of',
              description:
                'Should fail — the pc arm of the discriminated union requires targetUserId.',
            },
          ],
        },
      ],
    }
    expect(IntegrationResultSchema.safeParse(payload).success).toBe(false)
  })

  it('rejects an empty characters array (min 1)', () => {
    expect(IntegrationResultSchema.safeParse({ characters: [] }).success).toBe(false)
  })

  it('rejects more than 8 characters', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      ...minimalPayload.characters[0],
      userId: `0190a000-0000-7000-8000-00000000010${String(i)}`,
    }))
    expect(IntegrationResultSchema.safeParse({ characters: nine }).success).toBe(false)
  })
})
