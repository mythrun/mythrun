# ======== Shared-resource alarms (myth-6ik, myth-gb0, myth-z4f) ========
#
# Week 0 §6.3's critical-alarm table is split across two ownership boundaries.
# This file holds the half whose subject is a resource EVERY environment sits
# on: the single RDS instance, the single Redis replication group, the ALB, the
# wildcard ACM certificate, the NAT gateway. The other half — the API's health
# and 5xx rate, plus the log-derived billing and retrieval alarms — is
# per-environment and lives in infra/modules/serving/.
#
# WHY A SEPARATE TOPIC. The alerts topic that exists today, mythrun-staging-alerts,
# is declared in the staging workspace, and the dependency arrow runs
# staging → shared (staging reads shared's remote state; never the reverse).
# Shared alarms therefore cannot publish to it without inverting that arrow. The
# alternative — declaring these alarms in the staging workspace and reaching
# across to shared's outputs — was rejected: the production composition would
# then either duplicate every one of them (two pages for one database) or omit
# them, and "remember not to duplicate this" is not a property you can rely on.
# One shared resource, one alarm, one topic that is nobody's environment.
#
# NOTE FOR THE APPLY: the email subscription below lands in PendingConfirmation.
# Nothing on this topic delivers until someone with access to that inbox clicks
# the AWS confirmation link. Same contract as the staging topic.

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

# ======== SNS: shared alerts topic ========

resource "aws_sns_topic" "shared_alerts" {
  name = "mythrun-shared-alerts"

  # Customer-managed key, NOT alias/aws/sns. CloudWatch publishes as a service
  # principal, which the AWS-managed key's uneditable policy cannot authorize —
  # the alarms would go red and deliver nothing. See alerts-kms.tf.
  kms_master_key_id = aws_kms_key.alerts.arn

  tags = { Name = "mythrun-shared-alerts" }
}

resource "aws_sns_topic_subscription" "shared_alerts_email" {
  topic_arn = aws_sns_topic.shared_alerts.arn
  protocol  = "email"
  endpoint  = var.alerts_email
}

# ---- Topic policy (myth-gb0).
#
# Declaring ANY policy replaces SNS's default one, and that is the entire point.
# The default grants sns:Publish (among much else) to every principal in this
# account, conditioned only on the account matching. Replacing it means only the
# two AWS services that legitimately publish here can do so from the resource
# side; humans and roles still manage the topic through their IAM policies,
# because same-account access is satisfied by an identity policy OR a resource
# policy, not both.
#
# budgets.amazonaws.com is pre-authorized even though the cost budget currently
# notifies by email only. This is deliberate: AWS Budgets fails CLOSED and
# SILENTLY when a topic policy omits it — the budget simply stops delivering,
# with no error anywhere. Granting it up front means wiring the budget to this
# topic later is a one-line change that works, rather than a one-line change
# that appears to work. See the coupling note on myth-gb0.
#
# On conditions, the two statements are deliberately NOT symmetric, because
# what AWS documents about them is not symmetric.
#
# The Budgets statement is AWS-published verbatim (Cost Management guide,
# "Creating an Amazon SNS topic for budget notifications"), conditions included,
# so it carries both.
#
# The CloudWatch statement carries only aws:SourceAccount. Pinning
# aws:SourceArn to an alarm ARN pattern is not documented for CloudWatch, and
# an unpopulated condition key denies the call — producing precisely the
# silent non-delivery this whole file exists to avoid. SourceAccount is what
# actually closes the cross-account confused-deputy hole (another account's
# CloudWatch cannot publish here); the ARN pattern would only have added
# "and it must be an alarm rather than some other CloudWatch resource", which
# is not worth the risk of a condition nobody can verify from outside a live
# account.

data "aws_iam_policy_document" "shared_alerts_topic" {
  statement {
    sid     = "AllowCloudWatchAlarmsToPublish"
    effect  = "Allow"
    actions = ["SNS:Publish"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    resources = [aws_sns_topic.shared_alerts.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid     = "AWSBudgetsSNSPublishingPermissions"
    effect  = "Allow"
    actions = ["SNS:Publish"]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    resources = [aws_sns_topic.shared_alerts.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    # Budgets ARNs carry no region segment — note the double colon. Budgets is
    # a global service and its notifications originate from us-east-1 whatever
    # region the budget is viewed in.
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:budgets::${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

resource "aws_sns_topic_policy" "shared_alerts" {
  arn    = aws_sns_topic.shared_alerts.arn
  policy = data.aws_iam_policy_document.shared_alerts_topic.json
}

# ======== Alarms ========
#
# Gauge metrics on always-on resources (RDS, Redis) use
# treat_missing_data = "missing", which holds the alarm's last state through a
# gap rather than inventing one. Count metrics that are only emitted when
# something happens (5xx, NAT port-allocation errors) use "notBreaching", since
# for those "no data" genuinely means "nothing went wrong". The one deliberate
# exception is the certificate alarm — see its comment.

# ---- RDS CPU. Week 0 §6.3: CPU > 90% for 5 minutes.
# db.t4g.micro is burstable: sustained high CPU also burns the instance's CPU
# credit balance, after which it is throttled to baseline and everything gets
# slow in a way that does not look like a database problem from the app side.

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name        = "mythrun-rds-cpu-high"
  alarm_description = "RDS instance ${module.data.rds_instance_identifier} has been above 90% CPU for 5 minutes. On a burstable t4g instance this also drains the CPU credit balance, after which the database is throttled to baseline and stays slow. Check Performance Insights (enabled, 7-day retention) for the top SQL before resizing anything."

  namespace   = "AWS/RDS"
  metric_name = "CPUUtilization"
  dimensions  = { DBInstanceIdentifier = module.data.rds_instance_identifier }

  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  threshold           = 90
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.shared_alerts.arn]
  ok_actions    = [aws_sns_topic.shared_alerts.arn]

  tags = { Name = "mythrun-rds-cpu-high" }
}

# ---- RDS free storage. Week 0 §6.3: FreeStorageSpace < 2 GB.
# Storage autoscaling is on (max_allocated_storage), so this should normally be
# AWS's problem — which is exactly why it is worth alarming on. If free space is
# still falling through 2 GB, autoscaling has hit its ceiling or is failing, and
# a full volume takes Postgres read-only.
# Statistic is Minimum, not Average: this is a low-water-mark question.

resource "aws_cloudwatch_metric_alarm" "rds_storage_low" {
  alarm_name        = "mythrun-rds-storage-low"
  alarm_description = "RDS instance ${module.data.rds_instance_identifier} has less than 2 GB of free storage. Storage autoscaling is enabled, so reaching this means the autoscaling ceiling (max_allocated_storage, currently ${module.data.rds_allocated_storage_gb} GB allocated) has been hit or autoscaling is failing. A full volume puts Postgres into read-only and every write path in the app fails."

  namespace   = "AWS/RDS"
  metric_name = "FreeStorageSpace"
  dimensions  = { DBInstanceIdentifier = module.data.rds_instance_identifier }

  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 2 * 1024 * 1024 * 1024 # 2 GiB, in bytes — the metric's unit
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.shared_alerts.arn]
  ok_actions    = [aws_sns_topic.shared_alerts.arn]

  tags = { Name = "mythrun-rds-storage-low" }
}

# ---- Redis memory. Week 0 §6.3: memory usage > 80% for 5 minutes.
#
# This is the sharpest of the shared alarms because of a decision made
# elsewhere: the parameter group sets maxmemory-policy = noeviction, which BullMQ
# requires so it never loses queued jobs to an eviction. The consequence is that
# a full Redis does not shed load — it starts refusing writes, and every enqueue
# in the system fails. There is no graceful degradation past this line.
#
# One alarm per node. Staging runs a single node; the spec's production sizing
# adds a replica, and for_each means that replica arrives already monitored.
#
# DIMENSIONS: {CacheClusterId, CacheNodeId}, the two-dimension form — which is
# the only one AWS documents.
#
# This alarm was originally written with {CacheClusterId} alone. That was
# changed because no AWS statement confirms the one-dimension form is published,
# and the failure mode of guessing wrong is silent: a dimension set that matches
# no timeseries does not error, it parks the alarm in INSUFFICIENT_DATA forever
# while the console shows nothing wrong. Shipping the confirmed form costs
# nothing and removes the question entirely.
#
# What AWS actually states: "ElastiCache provides both host-level metrics (for
# example, CPU usage) and metrics that are specific to the cache engine
# software... These metrics are measured and published for each Cache node in
# 60-second intervals" (AmazonElastiCache/latest/dg/CacheMetrics.html) — and
# every CLI and API example on the monitoring page passes both keys:
#
#   --dimensions '[{"Name":"CacheClusterId","Value":"test"},
#                  {"Name":"CacheNodeId","Value":"0001"}]'
#   (AmazonElastiCache/latest/dg/CloudWatchMetrics.html)
#
# CacheNodeId is the constant "0001". In a cluster-mode-disabled replication
# group each member cache cluster holds exactly one node, and node IDs are
# 4-digit identifiers starting at 0001. Adding a read replica does NOT make this
# "0002": a replica is a new member CLUSTER (mythrun-redis-002) carrying its own
# node 0001. That is exactly why the fan-out below is over member cluster IDs
# and this value is fixed.
#
# Still worth confirming once after the first apply — a published metric is
# cheaper to look up than to reason about:
#
#   aws cloudwatch list-metrics --namespace AWS/ElastiCache \
#     --metric-name DatabaseMemoryUsagePercentage

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  for_each = toset(module.data.redis_member_cluster_ids)

  alarm_name        = "${each.value}-memory-high"
  alarm_description = "ElastiCache node ${each.value} is above 80% memory. maxmemory-policy is noeviction (BullMQ requires it, so queued jobs are never silently evicted), which means a full node does not evict — it REJECTS writes, and every job enqueue in the system starts failing. Check for a runaway queue backlog or an unbounded key namespace before resizing."

  namespace   = "AWS/ElastiCache"
  metric_name = "DatabaseMemoryUsagePercentage"
  dimensions = {
    CacheClusterId = each.value
    CacheNodeId    = "0001"
  }

  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.shared_alerts.arn]
  ok_actions    = [aws_sns_topic.shared_alerts.arn]

  tags = { Name = "${each.value}-memory-high" }
}

# ---- ALB 5xx. Week 0 §6.3: 5xx count > 50 in 5 minutes.
#
# HTTPCode_ELB_5XX_Count is the load balancer's OWN 5xx: 502 when a target
# returned something malformed, 503 when there were no healthy targets to send
# to, 504 when a target ran past the idle timeout. It is a different failure from
# the application returning a 500, which each environment alarms on separately
# via HTTPCode_Target_5XX_Count. Both exist because they point at different
# people: this one at the platform, that one at the code.

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name        = "mythrun-alb-5xx"
  alarm_description = "The shared ALB generated more than 50 of its own 5xx responses in 5 minutes (502 malformed target response, 503 no healthy targets, 504 target timeout). This is the load balancer's view, not the application's — if mythrun-<env>-api-down is also firing, start there."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_ELB_5XX_Count"
  dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 50
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.shared_alerts.arn]

  tags = { Name = "mythrun-alb-5xx" }
}

# ---- ACM expiry. Week 0 §6.3: DaysToExpiry < 30.
#
# The wildcard cert is DNS-validated and ACM renews it automatically at around
# 60 days out, so this alarm should never fire on the happy path. That is what
# makes it worth having: crossing 30 days means renewal has already failed
# twice over, usually because the _acme validation CNAME stopped resolving. The
# cert fronts every hostname we serve, so its expiry is a total outage.
#
# treat_missing_data = "breaching" on purpose. ACM publishes DaysToExpiry twice a
# day for certs it knows about; a metric that stops arriving means the cert this
# alarm names no longer exists, which is not a state to sleep through. Cert
# replacement changes the ARN, and Terraform updates this dimension in the same
# apply, so a legitimate rotation cannot strand the alarm on a dead ARN.

resource "aws_cloudwatch_metric_alarm" "acm_expiry" {
  alarm_name        = "mythrun-acm-wildcard-expiry"
  alarm_description = "The *.mythrun.com wildcard certificate is within 30 days of expiry. ACM auto-renews DNS-validated certs at ~60 days, so reaching 30 means renewal has been failing — check that the ACM validation CNAME still resolves in the Route 53 zone. This certificate fronts every hostname we serve; its expiry is a full outage."

  namespace   = "AWS/CertificateManager"
  metric_name = "DaysToExpiry"
  dimensions  = { CertificateArn = module.dns.wildcard_cert_arn }

  statistic           = "Minimum"
  period              = 86400 # one day; ACM emits DaysToExpiry twice daily
  evaluation_periods  = 1
  threshold           = 30
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.shared_alerts.arn]
  ok_actions    = [aws_sns_topic.shared_alerts.arn]

  tags = { Name = "mythrun-acm-wildcard-expiry" }
}

# ---- NAT source-port exhaustion (myth-z4f, item 3).
#
# Everything the tasks talk to outbound — Anthropic, Voyage, Stripe, Cognito,
# Secrets Manager — leaves through one NAT gateway. A NAT gateway can hold
# roughly 55,000 simultaneous connections to any single destination IP, and
# Anthropic is exactly the sort of single destination a fleet of long-lived
# streaming LLM calls piles onto. Past that ceiling, new connections fail to
# get a source port and the symptom in the app is a scatter of unexplained
# connection errors under load — a genuinely hard thing to diagnose from the
# application side, which is why it gets a metric instead of a hunch.
#
# ErrorPortAllocation is the direct signal: the count of times the gateway
# could not allocate a source port. Any nonzero value means the ceiling was hit.
#
# {NatGatewayId} alone is the correct dimension set for a ZONAL NAT gateway,
# which is what modules/network declares (a single gateway in the first AZ).
# AWS's newer regional NAT gateways publish with an added AvailabilityZone
# dimension; if this VPC ever moves to one, this alarm goes quiet rather than
# wrong, so revisit it in the same change.

resource "aws_cloudwatch_metric_alarm" "nat_port_allocation_errors" {
  alarm_name        = "mythrun-nat-port-allocation-errors"
  alarm_description = "The NAT gateway failed to allocate a source port — outbound connections are being dropped. This is port exhaustion toward a single destination (~55k simultaneous connections per destination IP); the likely culprit is concurrent long-lived streams to one upstream API. Symptom in the app is scattered connection failures under load. Remedies, in order: connection reuse / keep-alive in the HTTP clients, then a second NAT gateway, then VPC endpoints for the AWS-side destinations."

  namespace   = "AWS/NATGateway"
  metric_name = "ErrorPortAllocation"
  dimensions  = { NatGatewayId = module.network.nat_gateway_id }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.shared_alerts.arn]

  tags = { Name = "mythrun-nat-port-allocation-errors" }
}
