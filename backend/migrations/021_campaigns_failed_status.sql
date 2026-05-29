-- backend/migrations/021_campaigns_failed_status.sql
--
-- MYT-56: add 'failed' to campaigns.status CHECK.
--
-- Previously the constraint was ('setup', 'active', 'archived'). When the
-- character_integration stage failed terminally (e.g. LLM repair chain
-- exhausted on unparseable structured output), the pipeline_runs row was
-- marked failed but the campaign sat at status='setup' indefinitely —
-- clients polling GET /api/campaigns/:id couldn't distinguish "still
-- running" from "terminally broken". The MYT-55 staging smoke surfaced
-- this on 1 of 3 concurrent campaigns.
--
-- This migration adds 'failed' as a fourth allowed state. The
-- character-integration processor's terminal-failure arm now updates
-- campaigns.status='failed' so the bare GET response surfaces the
-- terminal state. The SSE-derived phase already reports 'failed' for
-- pipeline_runs.character_integration with status='failed' (see
-- derive-phase.ts:computePhase); this brings the column-level status into
-- agreement with the derived view.
--
-- Schema migration only; no data backfill needed — existing rows stay at
-- whichever of (setup, active, archived) they already had.

ALTER TABLE campaigns
  DROP CONSTRAINT IF EXISTS campaigns_status_check;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('setup', 'active', 'archived', 'failed'));
