// FreeformPrompt (MYT-90) — the path-chooser's freeform entry: a single seamless
// question the player answers in their own words (the "describe who you are" fork,
// the alternative to the guided builder). Platform-neutral (§9): the neutral
// `onChange(value)` / `onSubmit` callbacks, never DOM events; no className/style.

/** Props for the freeform character-concept prompt. */
export interface FreeformPromptProps {
  /** Optional resolved step signpost shown quietly above the prompt (e.g. the
   *  freeform path's "1 of 2" — so the player knows a second question follows
   *  and doesn't front-load their whole answer into the first). MYT-102. */
  stepIndicator?: string
  /** The resolved question shown as the seamless field's label. */
  prompt: string
  /** The quiet sub-line under the prompt (the "whisper" of guidance). */
  whisper: string
  /** The current field value (controlled). */
  value: string
  /** Neutral change callback carrying the new value — never a DOM event. */
  onChange: (v: string) => void
  /** Neutral submit callback (Enter / the commit control). */
  onSubmit: () => void
  /** Optional resolved placeholder for the empty field. */
  placeholder?: string
}
