-- A re-used (session_id, seq) must fail loudly (caught -> re-INCR upstream), never silently corrupt replay.
CREATE UNIQUE INDEX idx_session_messages_session_seq_unique
  ON session_messages (session_id, seq);
