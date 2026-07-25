// myth-gdycq — the pronoun ask, brain-side.
//
// Character creation asks, quietly and optionally, how the DM should refer to
// the player's character. The answer is a CHOICE, not free text: the backend
// pins the value over the model's echo (run 3 answered "he/his" for a character
// whose description never specified a gender), and a pin is only meaningful
// against tokens the server itself defines.
//
// `unset` is a real, selectable answer — "let the description decide" — and it
// is the DEFAULT. It is not sent on the wire: its absence is what tells the
// chargen prompt to read the description, and to fall back to they/them rather
// than guessing. So the UI has five options and the wire has four.

import type { PronounToken } from '../api/characters.ts'

/** The choices offered in the UI, in display order — the default first, then
 *  the four that commit to something. */
export const PRONOUN_CHOICES = ['unset', 'she_her', 'he_him', 'they_them', 'name_only'] as const

/** One selectable answer to the pronoun ask (a superset of the wire tokens). */
export type PronounChoice = (typeof PRONOUN_CHOICES)[number]

/** The default: let the character's own description decide. */
export const DEFAULT_PRONOUN_CHOICE: PronounChoice = 'unset'

/** Narrow an arbitrary string (a restored draft, a foreign value) to a choice;
 *  anything unrecognized falls back to the default rather than throwing. */
export function toPronounChoice(value: string | undefined): PronounChoice {
  return (PRONOUN_CHOICES as readonly string[]).includes(value ?? '')
    ? (value as PronounChoice)
    : DEFAULT_PRONOUN_CHOICE
}

/**
 * The structured pick this choice contributes to the submit body. `unset`
 * contributes NOTHING (a present-only field, per exactOptionalPropertyTypes and
 * the guided-choices wire convention) — the server then has no pin to apply and
 * the prompt's resolution order governs.
 */
export function pronounsPick(choice: PronounChoice): { pronouns?: PronounToken } {
  return choice === 'unset' ? {} : { pronouns: choice }
}
