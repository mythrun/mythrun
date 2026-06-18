-- 029_session_messages_fts.sql — MYT-74d
-- Full-text search over the player-facing transcript. A generated tsvector
-- column (auto-maintained on insert; the transcript is append-only) + a PARTIAL
-- GIN index over only the prose-bearing message types — mechanical JSON rows
-- (skill_check/dice_roll/world_fact_lookup/ledger) store JSON.stringify blobs,
-- not prose, and are excluded from search (D7). The partial predicate MUST stay
-- in lockstep with SEARCHABLE_MESSAGE_TYPES in repo/transcript-search.ts (an
-- EXPLAIN test pins the coupling). No CONCURRENTLY: the migration runner wraps
-- each file in a transaction. Lands pre-launch against an empty/near-empty
-- table, so the column add (full rewrite) + GIN build are effectively free.
ALTER TABLE session_messages
  ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX idx_session_messages_content_tsv
  ON session_messages USING GIN (content_tsv)
  WHERE message_type IN ('dm_text', 'player_message');
