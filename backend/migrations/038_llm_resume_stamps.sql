-- 038_llm_resume_stamps.sql — llm-outage-resilience spec §3.1: the parked-state
-- stamp, one row per parked prep run (world_gen / session_prep /
-- character_creation), keyed (pipeline, entity_id). The stamp — not the failed
-- pipeline_runs row — is what distinguishes "parked, will resume" from
-- "genuinely failed". next_resume_at clears on stage claim (NULL =
-- claimed/in-flight); resume_attempt / park_consumed_ms / last_error_class
-- survive claims and clear only with the row on stage completion. entity_id is
-- deliberately FK-free: it points at a world, campaign, or concept depending on
-- pipeline, and the row must outlive claim/retry churn on those tables.

CREATE TABLE llm_resume_stamps (
  pipeline        text        NOT NULL CHECK (pipeline IN ('world_gen','session_prep','character_creation')),
  entity_id       uuid        NOT NULL,
  resume_attempt  integer     NOT NULL DEFAULT 0,
  next_resume_at  timestamptz,           -- NULL = claimed/in-flight (cleared on stage claim)
  park_consumed_ms bigint     NOT NULL DEFAULT 0,
  last_error_class text       NOT NULL CHECK (last_error_class IN ('connectivity','rate-limit')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline, entity_id)
);
