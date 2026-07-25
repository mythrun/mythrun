-- 037_tripwire_verdicts.sql — myth-g4hf3: persist the per-turn secret-tripwire
-- verdict (severity / confidence / secretRef handle). The playthrough-2
-- forensics had to reconstruct the firing breach from two incidental
-- "skipping re-author" log lines; this table makes every verdict durable and
-- queryable per turn. HANDLE-ONLY by design: secret_ref stores the opaque
-- [SECRET-n] handle ([CONSISTENCY]/[UNRECOGNIZED] for non-secret verdicts),
-- never secret content — the scribe worker sanitizes before insert.

CREATE TABLE tripwire_verdicts (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id UUID NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('none', 'soft_consistency', 'hard_reveal')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  secret_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session-forensics read path (verdict timeline for one session).
CREATE INDEX idx_tripwire_verdicts_session ON tripwire_verdicts (session_id, created_at);
-- Per-turn lookup ("what did the tripwire say about THIS turn").
CREATE INDEX idx_tripwire_verdicts_turn ON tripwire_verdicts (turn_id);
