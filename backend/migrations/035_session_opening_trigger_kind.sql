-- 035_session_opening_trigger_kind.sql — MYT-101
--
-- Extends the closed trigger_kind set with 'session_opening': the prep-generated
-- DM introduction that POST /start persists deterministically as the session's
-- first dm_text row. Distinct from the turn-trigger kinds (it is not a turn),
-- recorded so the post-session analysis and attribution can name it; it is
-- deliberately NOT in analysis/containment.ts EXCLUDED_TRIGGER_KINDS — the
-- opening is real fiction the party experienced.

ALTER TABLE session_messages
  DROP CONSTRAINT session_messages_trigger_kind_check;
ALTER TABLE session_messages
  ADD CONSTRAINT session_messages_trigger_kind_check
    CHECK (trigger_kind IS NULL OR trigger_kind IN ('explicit', 'solo', 'auto', 'correction', 'farewell', 'session_opening'));
