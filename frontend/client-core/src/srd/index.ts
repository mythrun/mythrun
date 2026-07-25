// The `@mythrun/client-core/srd` subpath barrel (MYT-90). Static SRD 2014 reference
// data — the class/species/background option lists the guided character builder shows
// and flattens into concept text, plus the subclass-at-level table + lookup that gates
// the builder's optional Subclass step. Pure data (no DOM, no react-query, no
// transport), so it rides its own UI-safe subpath — the web builder surface consumes
// these lists WITHOUT dragging the whole client brain into its bundle, mirroring the
// `/worldgen` subpath. This is presentational input data only; NO mechanics live here
// (the backend LLM owns hit dice, saves, spell slots, proficiencies).

export { CLASSES, CLASS_OPTIONS, resolveClassName } from './classes.ts'
export type { ClassName, ClassOption } from './classes.ts'
export { SPECIES } from './species.ts'
export { BACKGROUNDS } from './backgrounds.ts'
export { SUBCLASS_LEVEL, subclassOfferedAt } from './subclass-level.ts'
export { CLASS_SAVES } from './class-saves.ts'
export type { Ability } from './class-saves.ts'
export { CASTING_ABILITY } from './casting-ability.ts'
