# ======== Per-environment operational alarms (myth-6ik) ========
#
# Week 0 §6.3's critical-alarm table, split across two ownership boundaries.
# This file holds the alarms whose subject is a PER-ENVIRONMENT resource — the
# API's target group and its 5xx rate. The alarms whose subject is a SHARED
# resource (the RDS instance, the Redis replication group, the ALB itself, the
# wildcard ACM cert, the NAT gateway) live in infra/environments/shared/alarms.tf
# and publish to the shared workspace's own SNS topic. Splitting them that way
# keeps each alarm declared exactly once: a production composition inherits
# these two by construction, and does NOT duplicate the shared ones into a
# second page for the same database.
#
# Everything here is skipped when no SNS topic is wired (alerts_topic_arn = ""),
# so a bring-up that has not yet created its topic still applies — same gate the
# billing alarms use.
#
# WORKER-DOWN IS DELIBERATELY ABSENT. Week 0 §6.3 lists it, and there is no
# honest way to express it today:
#   - Container Insights is disabled by design (shared/main.tf's ECS cluster
#     setting; ~$2.50/task/month), so ECS/ContainerInsights RunningTaskCount —
#     the metric the spec's "running task count = 0" wording assumes — is not
#     published at all.
#   - The worker has no ALB target group (it is not load-balanced), so the
#     HealthyHostCount path used for the API below does not exist for it.
# The two real options are (a) enable Container Insights at Launch, or (b) have
# the worker emit a heartbeat metric — the task role ALREADY carries
# cloudwatch:PutMetricData scoped to the Mythrun/<env> namespace (see
# aws_iam_role_policy.task_cloudwatch_metrics in main.tf), so (b) is a few lines
# of app code plus an alarm-on-missing here. Both are decisions with a cost, so
# neither is taken unilaterally. Until one lands, worker liveness is unmonitored
# and myth-6ik stays open for exactly this reason.

locals {
  # Shared by every alarm in this module (see also billing-alarms.tf and
  # retrieval-alarms.tf). One local, so "is alerting wired?" has one answer.
  alarms_enabled = var.alerts_topic_arn == "" ? 0 : 1
}

# ---- API down. The ALB is the only liveness signal that exists without
# Container Insights, and it is the better one anyway: it reports whether the
# API is answering /health/ready (the target group's health check), not merely
# whether a container process is running.
#
# treat_missing_data = "breaching" is load-bearing. A target group with zero
# registered targets stops emitting HealthyHostCount entirely rather than
# emitting a zero, so "no data" IS the outage — the service scaled to nothing,
# or every task failed to place. Any other setting silently sleeps through the
# worst case.
#
# 60s / 1 datapoint matches Week 0 §6.3's "running task count = 0 for 1 minute".
# A rolling deploy should not trip it: deployment_minimum_healthy_percent = 100
# keeps the old task registered and healthy until the new one passes its checks.
# If real deploys prove otherwise, raise evaluation_periods rather than the
# period — the goal is "down for N consecutive minutes", not a coarser sample.
#
# Statistic is MAXIMUM, which reads backwards until you know that Min/Max on
# this metric are computed across the load balancer's nodes, not across time.
# Minimum would fire when ANY single LB node reports zero healthy targets, which
# a transient per-node blip can do while the service is serving fine. Maximum
# below 1 means NO node can see a healthy target anywhere — which is what the
# word "down" in this alarm's name should mean. A partial failure, where one
# node sees targets and another does not, surfaces through the 5xx alarm below
# rather than as a false "everything is down" page at 3am.

resource "aws_cloudwatch_metric_alarm" "api_down" {
  count = local.alarms_enabled

  alarm_name        = "mythrun-${var.environment}-api-down"
  alarm_description = "No healthy API targets behind the ALB for 1 minute — ${var.environment} is serving 5xx or nothing at all. Check `aws ecs describe-services --cluster ${var.ecs_cluster_name} --services mythrun-${var.environment}-api` for placement failures, then the /mythrun/${var.environment}/api log group for a boot-gate refusal (the gate fails closed on an unreachable Postgres or Redis)."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HealthyHostCount"
  dimensions = {
    TargetGroup  = aws_lb_target_group.api.arn_suffix
    LoadBalancer = var.alb_arn_suffix
  }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  # OK action wired: recovery from an outage is exactly the edge an operator
  # mid-incident wants confirmed.
  alarm_actions = [var.alerts_topic_arn]
  ok_actions    = [var.alerts_topic_arn]

  tags = { Name = "mythrun-${var.environment}-api-down" }
}

# ---- API 5xx spike. Week 0 §6.3's "ALB 5xx spike: 5xx count > 50 in 5 minutes",
# scoped to THIS environment's target group.
#
# HTTPCode_Target_5XX_Count counts responses the application itself produced —
# an unhandled route error, a failed LLM call surfacing as a 500. Its sibling
# HTTPCode_ELB_5XX_Count (502/503/504 generated by the load balancer when the
# target is unreachable or too slow) is a property of the shared ALB and is
# alarmed once in the shared workspace.

resource "aws_cloudwatch_metric_alarm" "api_target_5xx" {
  count = local.alarms_enabled

  alarm_name        = "mythrun-${var.environment}-api-target-5xx"
  alarm_description = "The ${var.environment} API returned more than 50 5xx responses in 5 minutes. These are application-generated errors (the load balancer's own 502/503/504s are counted separately by mythrun-alb-5xx). Start at the /mythrun/${var.environment}/api log group filtered to level >= 50."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_Target_5XX_Count"
  dimensions = {
    TargetGroup  = aws_lb_target_group.api.arn_suffix
    LoadBalancer = var.alb_arn_suffix
  }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 50
  comparison_operator = "GreaterThanThreshold"
  # The ALB emits nothing for a request-count metric in a window with no
  # matching requests, and "no 5xx" is the healthy state.
  treat_missing_data = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]

  tags = { Name = "mythrun-${var.environment}-api-target-5xx" }
}
