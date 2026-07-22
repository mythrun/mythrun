import type { GuidedOption, RailStep } from './types.ts'

// GuidedBuilder (MYT-90) — the step-by-step character builder (class → subclass →
// species → background → notes). FULLY CONTROLLED: it holds NO internal step state;
// the parent (the B4 view-model) owns the cursor, the rail, and the current options,
// and advances them via the neutral callbacks. Platform-neutral (§9): `onSelect`
// carries the option id, the nav callbacks are plain functions — never DOM events.

/** The controlled builder's resolved nav control labels (shell-owned i18n). */
export interface GuidedBuilderLabels {
  /** Advance-to-next-step control (e.g. "Next"). */
  next: string
  /** Step-back control (e.g. "Back"). */
  back: string
  /** Escape-hatch to the freeform fork (e.g. "Describe them instead"). */
  switchToFreeform: string
}

/** Props for the controlled guided character builder. */
export interface GuidedBuilderProps {
  /** The resolved nav control labels (the shell resolves i18n and passes them). */
  labels: GuidedBuilderLabels
  /** The progress rail (one rung per step, with its state + chosen value). */
  rail: RailStep[]
  /** The current step's resolved question. */
  question: string
  /** The current step's selectable option cards. */
  options: GuidedOption[]
  /** The currently-selected option id, or `null` when nothing is picked yet. */
  selectedId: string | null
  /** Neutral selection callback carrying the chosen option's id. */
  onSelect: (id: string) => void
  /** Advance to the next step (commit the current pick). */
  onNext: () => void
  /** Step back to the previous step. */
  onBack: () => void
  /** Abandon the guided path for the freeform prompt fork. */
  onSkipToFreeform: () => void
}
