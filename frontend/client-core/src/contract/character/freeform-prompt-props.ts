// FreeformPrompt (MYT-90) — the path-chooser's freeform entry: a single seamless
// question the player answers in their own words (the "describe who you are" fork,
// the alternative to the guided builder). Platform-neutral (§9): the neutral
// `onChange(value)` / `onSubmit` callbacks, never DOM events; no className/style.

/** Props for the freeform character-concept prompt. */
export interface FreeformPromptProps {
  /** The resolved submit-control label (the shell resolves i18n and passes it). */
  submitLabel: string
  /**
   * Disable the commit control (the Button contract's honest gating — ux-run3
   * myth-7ceqw: a solid Continue over an empty required field promises an act
   * it won't perform; the accent fill is the reward for having written).
   * Default false. The Skip-shaped Notes step keeps it enabled — an empty
   * answer IS its sanctioned act.
   */
  submitDisabled?: boolean
  /**
   * Optional quiet mono line under the action row, seated by the commit
   * control — the commit disclosure at a generation trigger (rough duration /
   * cost; ux-run3 myth-g3mt6). Resolved display string.
   */
  submitHint?: string
  /**
   * Focus the field on mount — typing is the step's one next action (ux-run3
   * myth-en2jj). Remount per step to re-focus on step change.
   */
  focusOnMount?: boolean
  /** Optional step-back callback. When present the prompt renders a quiet Back
   *  control at the bottom-left of its action row — the flow's ONE Back position
   *  (ux-run2 myth-80an1: Back lives in the action row on every step, never a
   *  teleporting top-of-page label). Neutral callback, never a DOM event. */
  onBack?: () => void
  /** The resolved Back label (required when `onBack` is present). */
  backLabel?: string
  /** Size the field for a one-or-two-sentence detail (a ~3-line floor, still
   *  auto-growing) instead of the essay floor — an oversized empty field visually
   *  contradicts "add a detail" copy (ux-run2 myth-z45sb). Default false.
   *  Also the GROUNDING steps' floor (ux-run3 myth-21lpi): they answer a long
   *  DM invitation with a sentence or two, and the essay floor walked the field
   *  bottom AND the commit control off a 1280x720 frame. */
  compact?: boolean
  /** The whisper's register. `hint` (default) is the quiet italic form guidance.
   *  `dm` promotes the whisper to full body reading size in roman with a quiet
   *  left rule — for the AI's bespoke, personalized prompt (the DM's voice, not
   *  chrome; ux-run2 myth-4gnrp). */
  whisperVoice?: 'hint' | 'dm'
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
