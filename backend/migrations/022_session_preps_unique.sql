-- backend/migrations/022_session_preps_unique.sql
-- MYT-61: session prep is one record per (campaign, session_number). The UNIQUE
-- constraint makes the worker's INSERT ... ON CONFLICT resume sound and prevents
-- duplicate preps for the same session (002 had only a non-unique campaign index).
ALTER TABLE session_preps DROP CONSTRAINT IF EXISTS session_preps_campaign_session_key;
ALTER TABLE session_preps ADD CONSTRAINT session_preps_campaign_session_key
  UNIQUE (campaign_id, session_number);
