# ======== Cognito monitoring (myth-s48q, partial) ========
#
# Throttling alarms on the user pool. These live in the auth module rather than
# the environment root for the same reason the billing alarms live in the
# serving module: a production composition should inherit them by construction,
# not by someone remembering to add them.
#
# Everything here is gated on alerts_topic_arn, so an environment without a
# topic still applies cleanly.
#
# ---- WHAT IS DELIBERATELY NOT HERE ----
#
# (1) SignInSuccesses rate-of-change. The metric exists and carries
#     {UserPool, UserPoolClient}, but "sign-ins dropped unusually" has no
#     meaningful static threshold against a pool holding four synthetic smoke
#     users and no organic traffic. The right instrument is a CloudWatch
#     anomaly-detection band, and a band needs weeks of real traffic to train
#     on. It belongs to the production composition, not to staging.
#
# (2) Secret-age alarms on the OAuth credentials (mythrun/<env>/google-oauth,
#     mythrun/<env>/discord-oauth). Secrets Manager publishes NO age metric —
#     there is nothing to alarm on. These two secrets are hand-pasted values
#     with no rotation lambda, so the only paths are a scheduled job that reads
#     LastChangedDate and emits a custom metric, or the AWS Config managed rule
#     secretsmanager-secret-periodic-rotation. Both are new mechanisms rather
#     than new alarms, and the scheduled-job option overlaps the myth-fhri
#     scheduled task, so they are built together or not at all. myth-s48q stays
#     open for this half.

locals {
  cognito_alarms_enabled = var.alerts_topic_arn == "" ? 0 : 1

  # Federation metrics carry a third IdentityProvider dimension (see the
  # federation alarm below), so they fan out per provider. The names match the
  # provider_name arguments on the aws_cognito_identity_provider resources in
  # main.tf, and the list is empty until the two-pass IdP apply has run — an
  # alarm on a provider that does not exist would sit in INSUFFICIENT_DATA
  # forever.
  cognito_alarm_idp_names = var.idps_enabled && var.alerts_topic_arn != "" ? ["Google", "Discord"] : []
}

# ---- Native sign-in throttling.
#
# Cognito throttles per-account, not per-pool, so this firing means the account
# is over a Cognito request quota and users are being turned away at the door
# with no application-side error to find. Cognito publishes a datapoint ONLY
# when a request is actually throttled — a healthy pool emits nothing at all —
# which is why treat_missing_data must be notBreaching here. "breaching" would
# page continuously on a working system.

resource "aws_cloudwatch_metric_alarm" "sign_in_throttles" {
  count = local.cognito_alarms_enabled

  alarm_name        = "mythrun-${var.environment}-cognito-sign-in-throttles"
  alarm_description = "Cognito is throttling sign-ins on the ${var.environment} user pool. Quotas are per-account, so users are being refused before any Mythrun code runs and nothing will appear in the API logs. Check the AWS/Usage CallCount and ThrottleCount metrics for which Cognito operation is over quota, then request a quota increase — this does not resolve on its own."

  namespace   = "AWS/Cognito"
  metric_name = "SignInThrottles"
  dimensions = {
    UserPool       = aws_cognito_user_pool.main.id
    UserPoolClient = aws_cognito_user_pool_client.main.id
  }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]

  tags = { Name = "mythrun-${var.environment}-cognito-sign-in-throttles" }
}

# ---- Federated sign-in throttling, per identity provider.
#
# FederationThrottles is published with THREE dimensions —
# {UserPool, UserPoolClient, IdentityProvider} — not the two that the SignIn*
# metrics use. A CloudWatch metric is identified by its complete dimension set,
# so an alarm declared with only the first two would match no timeseries at all
# and sit in INSUFFICIENT_DATA forever while looking perfectly healthy in the
# console. Hence one alarm per provider.
#
# Mythrun is federated-only: the app client allows no password sign-in, so if
# both of these are firing, nobody can get in by any route.

resource "aws_cloudwatch_metric_alarm" "federation_throttles" {
  for_each = toset(local.cognito_alarm_idp_names)

  alarm_name        = "mythrun-${var.environment}-cognito-federation-throttles-${lower(each.value)}"
  alarm_description = "Cognito is throttling ${each.value} federated sign-ins on the ${var.environment} user pool. Mythrun has no password sign-in path, so ${each.value} users cannot get in at all while this is firing. Cognito quotas are per-account: check AWS/Usage ThrottleCount to find the operation that is over, and request an increase."

  namespace   = "AWS/Cognito"
  metric_name = "FederationThrottles"
  dimensions = {
    UserPool         = aws_cognito_user_pool.main.id
    UserPoolClient   = aws_cognito_user_pool_client.main.id
    IdentityProvider = each.value
  }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alerts_topic_arn]

  tags = { Name = "mythrun-${var.environment}-cognito-federation-throttles-${lower(each.value)}" }
}
