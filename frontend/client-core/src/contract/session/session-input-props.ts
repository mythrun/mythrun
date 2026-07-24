// SessionInput (MYT-92) — the controlled composer: a text field + a Send affordance +
// a prominent @DM summon. `onSend` fires the normal message; `onSummonDm` fires the
// explicit-text @dm path (the route wire composes the `@dm` token into the visible
// message so the table SEES the summon — the invisible dm_invoke frame is NOT used).
// The component exposes the two intents only; token insertion lives at the route wire.
// `disabled` gates both while the session is ended / not-ready. Platform-neutral (§9):
// neutral callbacks (never DOM events), resolved labels — no className/style.

/** Props for the play-session composer. */
export interface SessionInputProps {
  /** Controlled value of the input. */
  value: string
  /** Neutral change callback — the new value, never a DOM event. */
  onChange: (v: string) => void
  /** Send the current message (Enter or the Send affordance). */
  onSend: () => void
  /** Summon the DM — the explicit-text @dm path (the route wire adds the token). */
  onSummonDm: () => void
  /** Gate both intents while the session is ended / not-ready. Terminal: the
   *  field itself goes inert too. */
  disabled: boolean
  /** myth-dd63v — the DM is mid-turn (thinking or streaming) OR a skill-check
   *  card is awaiting Roll/Continue: SENDING is not the expected next action, so
   *  Send + the @DM summon are gated (and the quiet `busyLabel` names why), but
   *  the field STAYS typeable — drafting while the DM writes is honest, silently
   *  swallowing the send is the bug. `disabled` (terminal) supersedes this. */
  busy?: boolean
  /** Resolved caption shown while `busy` (and not `disabled`) — the "why Send is
   *  waiting" line, in the quiet between-turns register (e.g. "The DM is
   *  writing…"). Absent → no caption even when busy. */
  busyLabel?: string
  /** Resolved placeholder copy (the web layer fills it). */
  placeholder: string
  /** Resolved label for the @DM summon affordance. */
  summonLabel: string
  /** Resolved label for the Send affordance. */
  sendLabel: string
  /** Hard character cap on the composed message — mirrors the server's
   *  MAX_MESSAGE_TEXT_LEN so an over-long message can't be optimistically
   *  rendered, silently dropped, and (past the WS payload cap) trigger a
   *  reconnect storm (MYT-102 QA F1). Optional; unset = no cap. */
  maxLength?: number
}
