import type { Scene } from './types.ts'

// Bespoke exhibits — real @mythrun/ui components (and composed DS layouts) mounted
// in representative states, reading their strings live from i18n. Populated in
// scene-library.tsx once the component fixtures are ready; every key NOT covered
// here falls back to a faithful typographic context card, so coverage is total
// regardless of how many scenes exist.
import { sceneLibrary } from './scene-library.tsx'

export const scenesByFlow: Record<string, Scene[]> = sceneLibrary
