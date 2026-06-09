-- 024_session_messages_dm_rows.sql — MYT-68 §3.7 PG-direct transcript.
-- DM turns persist as rows: message_type IN ('dm_text','skill_check','dice_roll')
-- (message_type is free TEXT; no CHECK — the repo layer owns the kind set).
-- turn_id groups one DM turn's rows; turn_ordinal (0..n-1) is the in-turn
-- emission order AND the idempotency key: a BullMQ re-run's re-append hits
-- ON CONFLICT (turn_id, turn_ordinal) DO NOTHING, so the first commit wins.
ALTER TABLE session_messages ADD COLUMN turn_id UUID;
ALTER TABLE session_messages ADD COLUMN turn_ordinal SMALLINT;

CREATE UNIQUE INDEX idx_session_messages_turn_ordinal_unique
  ON session_messages (turn_id, turn_ordinal) WHERE turn_id IS NOT NULL;

-- The per-turn reconstruction read (§3.7) filters on session + message_type;
-- the existing (session_id, seq) unique index covers the ORDER BY seq scan.
