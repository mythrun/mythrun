# ======== Billing Alarms (myth-89am / myth-e3ary) ========
#
# Hard-blocking precondition for production-launch readiness per the MYT-41
# spec: Mythrun does not promote to production until these alarms are live.
#
# Everything here is a log-metric-filter over the API task's structured pino
# output. The app emits one JSON object per line and the awslogs driver ships
# those lines verbatim, so `$.event` / `$.msg` address pino's top-level merge
# object and its message key directly. Only the API task runs the boot probe
# and the webhook dispatcher, so the API log group is the only source.
#
# These alarms live in the serving module rather than the environment root so
# a future production composition inherits them by construction — an alarm
# that has to be remembered per-environment is an alarm that will be missing
# in the environment that matters.
#
# `default_value = "0"` on each transformation makes the metric report zero
# on every non-matching line, so the alarms sit in a real OK state instead of
# INSUFFICIENT_DATA and recover on their own once the condition clears.
#
# Alarms are skipped entirely when no SNS topic is wired (alerts_topic_arn
# = ""), so a bring-up that has not yet created its topic still applies. That
# gate is `local.alarms_enabled`, declared once in alarms.tf and shared by every
# alarm in this module.

# ---- Stripe config drift: the boot probe found the Stripe account in a shape
# the code cannot safely run against. The task is crashlooping and ECS is
# rolling the deploy back. Response: fix the Stripe Dashboard, not the code.
#
# All three events share one metric because they share one response. They are
# separable in the logs by `$.event` and each carries a `mismatches` array
# naming exactly what drifted.
#   - billing.probe_failed                 — a lookup_key's price drifted
#   - billing.probe_portal_failed          — Customer Portal config drifted
#   - billing.probe_webhook_version_failed — a webhook endpoint's api_version
#     drifted from the SDK pin. REVENUE-CRITICAL: events are rendered once at
#     the endpoint's version and cannot be re-rendered on retrieval, so a
#     drifted endpoint means every delivery is dropped uncredited (myth-e3ary).

resource "aws_cloudwatch_log_metric_filter" "billing_probe_config_failure" {
  name           = "mythrun-${var.environment}-billing-probe-config-failure"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.event = \"billing.probe_failed\" || $.event = \"billing.probe_portal_failed\" || $.event = \"billing.probe_webhook_version_failed\" }"

  metric_transformation {
    name          = "BillingProbeConfigFailure"
    namespace     = "Mythrun/${var.environment}/Billing"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "billing_probe_config_failure" {
  count = local.alarms_enabled

  alarm_name        = "mythrun-${var.environment}-billing-probe-config-failure"
  alarm_description = "Stripe contract drift detected at boot (price / Customer Portal / webhook-endpoint api_version). The API task is failing its boot gate and ECS is rolling the deploy back. Check the `mismatches` field on the billing.probe_*_failed log line and correct the Stripe Dashboard."

  namespace           = "Mythrun/${var.environment}/Billing"
  metric_name         = "BillingProbeConfigFailure"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  # alarm_actions only: these fire on a boot that already failed, so an OK
  # transition just means "the crashlooping task stopped emitting" — not a
  # recovery worth paging on.
  alarm_actions = [var.alerts_topic_arn]

  tags = { Name = "mythrun-${var.environment}-billing-probe-config-failure" }
}

# ---- Stripe credential failure. The key is rejected or lacks a needed scope.
# Response: rotate / re-scope STRIPE_SECRET_KEY in Secrets Manager.

resource "aws_cloudwatch_log_metric_filter" "billing_probe_auth_failure" {
  name           = "mythrun-${var.environment}-billing-probe-auth-failure"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.event = \"billing.probe_auth_failed\" }"

  metric_transformation {
    name          = "BillingProbeAuthFailure"
    namespace     = "Mythrun/${var.environment}/Billing"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "billing_probe_auth_failure" {
  count = local.alarms_enabled

  alarm_name        = "mythrun-${var.environment}-billing-probe-auth-failure"
  alarm_description = "Stripe rejected the API key at boot (authentication or permission). The API task is failing its boot gate. Rotate or re-scope STRIPE_SECRET_KEY in Secrets Manager and redeploy."

  namespace           = "Mythrun/${var.environment}/Billing"
  metric_name         = "BillingProbeAuthFailure"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]

  tags = { Name = "mythrun-${var.environment}-billing-probe-auth-failure" }
}

# ---- Stripe unreachable. The probe exhausted its retries (or the portal
# check failed single-shot) against a Stripe outage or a network fault.
# Distinct from the two above because the fix is not ours: check
# status.stripe.com and the task's egress path before touching config.

resource "aws_cloudwatch_log_metric_filter" "billing_probe_transient_failure" {
  name           = "mythrun-${var.environment}-billing-probe-transient-failure"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.event = \"billing.probe_transient_failed\" || $.event = \"billing.probe_portal_transient_failed\" }"

  metric_transformation {
    name          = "BillingProbeTransientFailure"
    namespace     = "Mythrun/${var.environment}/Billing"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "billing_probe_transient_failure" {
  count = local.alarms_enabled

  alarm_name        = "mythrun-${var.environment}-billing-probe-transient-failure"
  alarm_description = "The Stripe boot probe exhausted its retries against an unreachable Stripe API, so the API task cannot boot. Check status.stripe.com and the task's NAT / egress path before changing any billing config."

  namespace           = "Mythrun/${var.environment}/Billing"
  metric_name         = "BillingProbeTransientFailure"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]

  tags = { Name = "mythrun-${var.environment}-billing-probe-transient-failure" }
}

# ---- REVENUE: a webhook delivery was dropped on the api_version gate.
#
# This is the runtime backstop for myth-e3ary and the single most
# money-relevant signal in this file. A Stripe Event is immutable — it is
# rendered once at the delivering endpoint's api_version and cannot be
# re-rendered — so when that version disagrees with the SDK pin the
# dispatcher can only fail closed: it acks with a 200 and runs no handler.
# A paid customer is charged and never credited, silently, on every delivery.
#
# The boot probe above is meant to catch this first. This alarm exists for
# the cases the boot probe cannot see: the endpoint's version changed while
# the task was already running, or the probe was disarmed because the
# restricted key lacks `webhook_endpoints: read`.
#
# Matched on `$.msg` (not `$.event`) because the dispatcher logs through
# Fastify's request logger, where the event name is the pino message.
#
# The dropped events are recoverable: the mismatch path deliberately does not
# write the stripe_events row, so `stripe events resend` (or a sweep over
# Stripe's 30-day event retention) will reprocess them once the endpoint
# version is realigned. Triage from the log line's `event_type` field, which
# names which deliveries were lost.

resource "aws_cloudwatch_log_metric_filter" "stripe_webhook_api_version_mismatch" {
  name           = "mythrun-${var.environment}-stripe-webhook-api-version-mismatch"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.msg = \"stripe_webhook_api_version_mismatch\" }"

  metric_transformation {
    name          = "StripeWebhookApiVersionMismatch"
    namespace     = "Mythrun/${var.environment}/Billing"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "stripe_webhook_api_version_mismatch" {
  count = local.alarms_enabled

  alarm_name        = "mythrun-${var.environment}-stripe-webhook-api-version-mismatch"
  alarm_description = "REVENUE: Stripe webhook deliveries are being dropped because the delivering endpoint's api_version does not match the SDK pin. Paid customers are NOT being credited. Fix: the endpoint's api_version is CREATE-ONLY on the Stripe API, so unless the Dashboard offers a version control on the endpoint you must create a replacement endpoint pinned to the STRIPE_API_VERSION the running image was built with, move its new signing secret into Secrets Manager, redeploy, then delete the old endpoint. Afterwards replay the dropped events with `stripe events resend` (they were deliberately left unrecorded so they remain replayable within Stripe's 30-day retention)."

  namespace           = "Mythrun/${var.environment}/Billing"
  metric_name         = "StripeWebhookApiVersionMismatch"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  # OK action wired here (unlike the boot alarms): this condition is fixed in
  # the Stripe Dashboard on a running service, so the recovery edge is real
  # and worth confirming to whoever is mid-incident.
  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  tags = { Name = "mythrun-${var.environment}-stripe-webhook-api-version-mismatch" }
}
