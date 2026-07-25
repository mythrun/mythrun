// backend/src/session/srd/__tests__/subclasses.test.ts
//
// myth-4jhrk: pins the 12-entry SRD 2014 subclass table verbatim against the
// guided builder's catalog (frontend/client-core/src/srd/classes.ts +
// subclass-level.ts). The two packages cannot import each other, so this test
// is the drift alarm: if either side changes a name or a grant level, the
// exact-row pin below goes red.

import { describe, expect, it } from 'vitest'
import { SRD_SUBCLASSES, srdSubclassFor } from '../subclasses.js'

describe('SRD_SUBCLASSES', () => {
  it('carries exactly the 12 SRD 2014 rows the guided builder offers', () => {
    expect(SRD_SUBCLASSES).toEqual([
      { className: 'barbarian', subclass: 'Berserker', subclassLevel: 3 },
      { className: 'bard', subclass: 'College of Lore', subclassLevel: 3 },
      { className: 'cleric', subclass: 'Life Domain', subclassLevel: 1 },
      { className: 'druid', subclass: 'Circle of the Land', subclassLevel: 2 },
      { className: 'fighter', subclass: 'Champion', subclassLevel: 3 },
      { className: 'monk', subclass: 'Way of the Open Hand', subclassLevel: 3 },
      { className: 'paladin', subclass: 'Oath of Devotion', subclassLevel: 3 },
      { className: 'ranger', subclass: 'Hunter', subclassLevel: 3 },
      { className: 'rogue', subclass: 'Thief', subclassLevel: 3 },
      { className: 'sorcerer', subclass: 'Draconic Bloodline', subclassLevel: 1 },
      { className: 'warlock', subclass: 'The Fiend', subclassLevel: 1 },
      { className: 'wizard', subclass: 'School of Evocation', subclassLevel: 2 },
    ])
  })
})

describe('srdSubclassFor', () => {
  it('resolves an exact class name', () => {
    expect(srdSubclassFor('cleric')).toMatchObject({ subclass: 'Life Domain', subclassLevel: 1 })
  })

  it('normalizes case and surrounding whitespace (stage-2 emits canonical-but-cased names)', () => {
    expect(srdSubclassFor(' Cleric ')).toMatchObject({ subclass: 'Life Domain' })
    expect(srdSubclassFor('WIZARD')).toMatchObject({ subclass: 'School of Evocation' })
  })

  it('misses on flavored class names — the gate only applies to exact SRD classes', () => {
    expect(srdSubclassFor('Storm-Touched Sorcerer')).toBeNull()
    expect(srdSubclassFor('Hollow Knight')).toBeNull()
    expect(srdSubclassFor('')).toBeNull()
  })
})
