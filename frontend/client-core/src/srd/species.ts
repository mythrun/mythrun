// SRD 2014 species catalog for the guided character builder (MYT-90). Canonical
// English species names — the option list the builder renders and flattens into
// concept text. Ported verbatim (and in order) from the validated single-player
// prototype's `data/srd/species.json` (read-only reference). Names only — NO
// mechanics (ability bonuses, speed, size, traits); the backend LLM owns those.

/** The 9 SRD 2014 species, canonical English names, in prototype order. */
export const SPECIES: readonly string[] = [
  'Dwarf',
  'Elf',
  'Halfling',
  'Human',
  'Dragonborn',
  'Gnome',
  'Half-Elf',
  'Half-Orc',
  'Tiefling',
]
