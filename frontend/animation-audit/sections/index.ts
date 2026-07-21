import type { AuditSection } from '../types.ts'
import { worldgenSections } from './worldgen.tsx'
import { revealSections } from './reveal.tsx'
import { sessionSections } from './session.tsx'
import { characterSections } from './character.tsx'
import { rollSections } from './roll.tsx'
import { streamSections } from './stream.tsx'

// The gallery inventory, in exhibit order. Each cluster file replicates the
// components' Storybook story drivers verbatim. Static textures (Dither,
// CoverDither) and the non-visual GenerationAnnouncer are intentionally excluded.
export const allSections: AuditSection[] = [
  ...worldgenSections,
  ...revealSections,
  ...sessionSections,
  ...characterSections,
  ...rollSections,
  ...streamSections,
]
