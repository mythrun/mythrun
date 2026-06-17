-- 028_session_messages_trigger_kind.sql — MYT-74b §5
-- The originating turn trigger kind on each DM-authored row, so the post-session
-- analysis can STRUCTURALLY exclude correction/farewell rows from NPC voice-excerpt
-- selection. This is an enforced-ignorance boundary: a MYT-73 retcon line (or a
-- farewell wind-down line) re-injected into the next session's ft_context would hand
-- the FastThinker a pointer to the secret the retcon spent an Opus call to bury. The
-- [[DM CORRECTION:]] marker does NOT survive into persisted content, and message_type
-- is the row KIND (dm_text/player_message/…) not the trigger, so neither is derivable —
-- the trigger kind must be recorded explicitly.
--
-- NULL for player rows (the single-row append path) + all pre-migration rows. The
-- CHECK pins the closed set of turn-trigger kinds (co-evolves with TurnJobPayload.trigger.kind).
ALTER TABLE session_messages
  ADD COLUMN trigger_kind TEXT
    CHECK (trigger_kind IS NULL OR trigger_kind IN ('explicit', 'solo', 'auto', 'correction', 'farewell'));
