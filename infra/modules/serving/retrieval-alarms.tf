# ======== Retrieval / embedding alarms (myth-bt6j) ========
#
# Defense-in-depth for the Voyage embedding dependency, mirroring the shape
# billing-alarms.tf established: log-metric-filters over the tasks' structured
# pino output, one metric per operator response, alarms gated on
# local.alarms_enabled.
#
# The boot probe (backend/src/boot/voyage-probe.ts) already covers DEPLOY-time
# misconfiguration loudly — a config-class Voyage error throws, the task
# crashloops, and ECS rolls the deploy back. What it cannot cover is the key
# being revoked, re-scoped, or dimension-changed while tasks are ALREADY
# RUNNING. In that window nothing crashes: world-gen keeps producing content
# and simply leaves every embedding NULL, so retrieval silently degrades to
# whatever was embedded before the break. That is the failure this file exists
# to catch.
#
# Both log groups are wired because the two failure surfaces do not overlap:
#   - The API task runs the boot probe (server.ts) — so does the worker.
#   - Only the WORKER runs the world-gen and character-integration pipelines,
#     which is where the runtime embed events come from.
# Two filters writing the same metric name in the same namespace is supported
# and is what we want: one metric, one alarm, one page, regardless of which
# task noticed first. Triage by log group + `$.event` from the alarm.

# ---- CONFIG class: the key / model / output-dimension is wrong. Never
# self-heals, breaks EVERY world, and is fixed the same way in all three cases
# (correct VOYAGE_API_KEY in Secrets Manager, or realign the model + dim in
# backend/src/world/retrieval/config.ts, then redeploy).
#
#   - boot.voyage_probe.misconfigured        — caught at boot; task refuses to
#     start (api or worker).
#   - world_gen.embed_world_misconfigured    — caught mid-pipeline; the stage is
#     TOTAL so the world still completes, with NULL embeddings.
#   - character_integration.embed_misconfigured — same, on the character path.
#
# The last two are the dangerous ones precisely because nothing fails loudly.

resource "aws_cloudwatch_log_metric_filter" "voyage_misconfigured_api" {
  name           = "mythrun-${var.environment}-voyage-misconfigured-api"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.event = \"boot.voyage_probe.misconfigured\" }"

  metric_transformation {
    name          = "VoyageMisconfigured"
    namespace     = "Mythrun/${var.environment}/Retrieval"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "voyage_misconfigured_worker" {
  name           = "mythrun-${var.environment}-voyage-misconfigured-worker"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"boot.voyage_probe.misconfigured\" || $.event = \"world_gen.embed_world_misconfigured\" || $.event = \"character_integration.embed_misconfigured\" }"

  metric_transformation {
    name          = "VoyageMisconfigured"
    namespace     = "Mythrun/${var.environment}/Retrieval"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "voyage_misconfigured" {
  count = local.alarms_enabled

  alarm_name        = "mythrun-${var.environment}-voyage-misconfigured"
  alarm_description = "Voyage is MISCONFIGURED (bad key, wrong model, or wrong output dimension). This never self-heals and it affects every world: at boot the task refuses to start, and at runtime the world-gen and character-integration embed stages complete while leaving every vector NULL, so retrieval silently degrades. Fix VOYAGE_API_KEY in Secrets Manager (or realign the model + dim in backend/src/world/retrieval/config.ts) and redeploy, then run the embedding backfill for anything written during the gap. Triage from the log line's `$.event` and its configErrorKind field."

  namespace           = "Mythrun/${var.environment}/Retrieval"
  metric_name         = "VoyageMisconfigured"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  # alarm_actions only. An OK transition here means "nothing re-emitted the
  # event in the last window", which happens as soon as a crashlooping task
  # stops or the worker runs out of worlds to embed — not a real recovery.
  alarm_actions = [var.alerts_topic_arn]

  tags = { Name = "mythrun-${var.environment}-voyage-misconfigured" }
}

# ---- AVAILABILITY class: Voyage is reachable-but-failing, or was unreachable
# past the boot probe's retries. Rows are left NULL for the operational
# backfill and the system keeps running degraded. The fix is usually not ours
# (check Voyage's status and the task's NAT egress), which is why this is a
# separate metric from the config class above.
#
#   - boot.voyage_probe.unreachable  — the probe gave up after its retries and
#     booted DEGRADED on purpose.
#   - world_gen.embed_world_failed   — the embed stage threw; rows left NULL.
#
# Deliberately EXCLUDED: world_gen.embed_world_degraded. That one is logged at
# WARN for a partial transient blip that the backfill recovers on its own, and
# alarming on it would page for the system working as designed.
#
# 2-of-3 five-minute windows, rather than 1, is the whole point of this alarm's
# shape: a single failed embed during a Voyage blip is expected and self-heals.
# Two windows out of three means it is persisting, and that is when someone
# needs to look.

resource "aws_cloudwatch_log_metric_filter" "voyage_unavailable_api" {
  name           = "mythrun-${var.environment}-voyage-unavailable-api"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.event = \"boot.voyage_probe.unreachable\" }"

  metric_transformation {
    name          = "VoyageUnavailable"
    namespace     = "Mythrun/${var.environment}/Retrieval"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "voyage_unavailable_worker" {
  name           = "mythrun-${var.environment}-voyage-unavailable-worker"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "{ $.event = \"boot.voyage_probe.unreachable\" || $.event = \"world_gen.embed_world_failed\" }"

  metric_transformation {
    name          = "VoyageUnavailable"
    namespace     = "Mythrun/${var.environment}/Retrieval"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "voyage_unavailable" {
  count = local.alarms_enabled

  alarm_name        = "mythrun-${var.environment}-voyage-unavailable"
  alarm_description = "Voyage has been failing or unreachable across two of the last three 5-minute windows. Worlds still generate, but their facts and entities are being written with NULL embeddings and retrieval is degrading as the gap grows. Check Voyage's status page and the task's NAT egress path; once it recovers, run the embedding backfill over anything written during the outage."

  namespace           = "Mythrun/${var.environment}/Retrieval"
  metric_name         = "VoyageUnavailable"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  # OK action wired: unlike the config class, this one genuinely recovers on
  # its own when the upstream comes back, and knowing that is what tells an
  # operator to go run the backfill.
  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  tags = { Name = "mythrun-${var.environment}-voyage-unavailable" }
}
