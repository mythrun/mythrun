// Flatten the guided character picks into a well-formed English concept sentence
// for the backend prep LLM (MYT-90). The class is emitted by its CANONICAL English
// SRD name (never localized display copy): client-core carries locale-independent
// LLM input — the `[ph:]` display copy is a later web-layer concern. The subclass
// clause is omitted entirely when the party's starting level does not yet grant the
// class its subclass (the SAME gate the guided builder uses to skip the Subclass
// step), so a stale subclass carried in the draft never leaks into the concept text.

import { CLASS_OPTIONS, subclassOfferedAt } from '../srd/index.ts'
import type { ClassName, GuidedChoice } from '../contract/index.ts'

// Canonical class name lookup, DERIVED from CLASS_OPTIONS (the source of truth) so
// the names never drift from the catalog. `Object.fromEntries` widens the key to
// `string`, so we re-narrow to the exact `ClassName` record — indexing it by a
// `ClassName` then yields a definite `string` with no undefined-fallback branch
// (unlike `.find`, whose miss branch would be unreachable-but-uncoverable).
const CLASS_NAME_BY_ID = Object.fromEntries(
  CLASS_OPTIONS.map((option) => [option.id, option.name]),
) as Record<ClassName, string>

/** The canonical English SRD display name for a class id (e.g. `'fighter'` →
 *  `'Fighter'`). Shared with the guided builder's progress rail. */
export function canonicalClassName(className: ClassName): string {
  return CLASS_NAME_BY_ID[className]
}

/**
 * Compose the concept sentence from the guided picks at the party's starting
 * `level`. The subclass clause is included only when a subclass is chosen AND the
 * level grants it; notes are appended only when present and non-empty.
 *
 * Example (`level >= 3`):
 *   `{ className:'fighter', subclass:'Champion', species:'Human',
 *      background:'Toll-clerk', notes:'never stops counting' }`
 *   → "I am a Fighter, a Champion. I am a Human with a Toll-clerk background. never stops counting"
 */
export function flattenToConceptText(choices: GuidedChoice, level: number): string {
  const className = canonicalClassName(choices.className)

  // Inline the subclass gate so the true branch narrows `subclass` to a string.
  const classClause =
    choices.subclass !== undefined && subclassOfferedAt(choices.className, level)
      ? `I am a ${className}, a ${choices.subclass}.`
      : `I am a ${className}.`
  const originClause = `I am a ${choices.species} with a ${choices.background} background.`

  const parts = [classClause, originClause]
  if (choices.notes !== undefined && choices.notes.length > 0) parts.push(choices.notes)
  return parts.join(' ')
}
