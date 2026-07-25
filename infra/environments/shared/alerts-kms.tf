# ======== KMS key for the alerts topics ========
#
# THIS EXISTS BECAUSE THE ALARMS WOULD OTHERWISE NEVER DELIVER.
#
# Both alerts topics are encrypted at rest. The obvious choice —
# `kms_master_key_id = "alias/aws/sns"`, the AWS-managed key, free — does not
# work once anything other than an IAM principal in this account publishes to
# the topic. Encrypting a message requires the publisher's call to reach
# kms:GenerateDataKey on the key, and the AWS-managed key's policy grants that
# only to principals in the account calling through SNS. A CloudWatch alarm
# publishes as the service principal cloudwatch.amazonaws.com, which is not such
# a principal, so KMS refuses. The AWS-managed key's policy cannot be edited to
# add it — that is the whole distinction between an AWS-managed and a
# customer-managed key.
#
# The failure mode is the reason this is worth a dollar a month. Alarm state
# evaluation is independent of action delivery, so the alarm still transitions to
# ALARM and the console still shows it red — the notification is simply never
# sent. The only evidence is a line in the alarm's History tab reading "Failed to
# execute action ...: CloudWatch Alarms does not have authorization to access the
# SNS topic encryption key." SNS's NumberOfNotificationsFailed does not help
# either: the Publish is rejected before the message enters SNS, so there is
# nothing for SNS to count as failed. An alerting system that looks armed and is
# not is worse than no alerting system, because you stop watching.
#
# VERIFY AFTER THE APPLY, once, per topic — a green plan proves nothing here:
#   aws cloudwatch set-alarm-state --alarm-name mythrun-staging-api-down \
#     --state-value ALARM --state-reason "delivery smoke test"
# The email should arrive. Then let it settle back on its own, or set it to OK.
#
# So: one customer-managed key, shared by the shared-workspace topic and each
# environment's topic (the staging workspace reads alerts_kms_key_arn from this
# workspace's remote state). One key, not one per topic — they have identical
# policies and the same two service principals publish to both.
#
# SUBSCRIBER SWEEP, done 2026-07-25 rather than assumed: both topics have
# exactly one subscription each, `protocol = "email"`. Email endpoints are not
# IAM principals and need no KMS grant — SNS decrypts server-side before
# delivery. There is no SQS queue, no Lambda, and no `sns:Publish` anywhere in
# backend/ or infra/ outside these two topics, so no other principal needs
# adding. That changes the day a non-email subscriber appears: an SQS queue, a
# Lambda, or a chat-webhook relay needs kms:Decrypt on this key, or it silently
# receives nothing for the same reason CloudWatch would have.

data "aws_iam_policy_document" "alerts_kms" {
  # Without this, the key is unmanageable: IAM policies in the account cannot
  # grant access to a KMS key unless the key policy first delegates to the
  # account. This is AWS's documented default key policy statement, not an
  # over-broad grant — it is what makes `aws kms` and Terraform work at all.
  statement {
    sid       = "EnableIAMUserPermissions"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  # ---- CloudWatch Alarms. GenerateDataKey* is the encrypt path (SNS asks KMS
  # for a data key on the publisher's behalf); Decrypt is what lets SNS read the
  # message back to deliver it.
  #
  # PROVENANCE: this statement is AWS-published, copied from the shape in the
  # Premium Support article "Configure a CloudWatch alarm with an encrypted SNS
  # topic" — same Sid, same two actions, Resource "*", and NO Condition block.
  #
  # Unconditioned deliberately. The SNS key-management guide offers generic
  # advice to add aws:SourceAccount / aws:SourceArn for confused-deputy
  # protection and then defers to per-service documentation for the exact
  # shape — which for CloudWatch does not exist. A condition key that the
  # service does not populate denies the call, and THAT failure looks exactly
  # like the bug this key exists to fix: alarm red, nothing delivered. The grant
  # is narrow in what it permits anyway — a service principal that can wrap a
  # data key under a key used by nothing but two alerting topics gains nothing
  # worth having.
  statement {
    sid    = "Allow_CloudWatch_for_CMK"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
  }

  # ---- AWS Budgets.
  #
  # PROVENANCE: INFERRED — NOT AWS-PUBLISHED. Treat it as a hypothesis to smoke
  # test, not as documentation.
  #
  # AWS's Cost Management guide has a real documentation bug here. Its section
  # "To enable compatibility between AWS Budgets and encrypted Amazon SNS
  # topics" says "2. Add the following text to the KMS key policy" — and then no
  # JSON follows. The omission is present on all three mirrors (/cost-management,
  # /awsaccountbilling, docs.amazonaws.cn). AWS has never published the statement
  # it tells you to add.
  #
  # So this is the SNS guide's generic service-principal template with the
  # principal substituted. The one thing that IS documented on that page is the
  # SNS *topic* policy Budgets needs, and its conditions are mirrored here.
  #
  # Nothing publishes budget notifications to these topics today (the budget
  # notifies by email), so an error here is currently inert. It matters the day
  # someone wires spend alerts to SNS — and Budgets at least fails LOUDLY,
  # unlike CloudWatch: the console surfaces "The SNS topic is encrypted" at
  # budget edit time rather than silently dropping notifications.
  statement {
    sid    = "AllowBudgetsToUseTheKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    # Budgets ARNs carry no region segment — note the double colon.
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:budgets::${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

resource "aws_kms_key" "alerts" {
  description         = "Encrypts the Mythrun alerts SNS topics. Customer-managed because CloudWatch Alarms and AWS Budgets publish as service principals, which the AWS-managed aws/sns key cannot authorize."
  enable_key_rotation = true

  # 30 days rather than the 7-day minimum: scheduling this key for deletion
  # would silently disarm every alarm in the account, and that is a mistake
  # worth having a month to notice.
  deletion_window_in_days = 30

  policy = data.aws_iam_policy_document.alerts_kms.json

  tags = { Name = "mythrun-alerts" }
}

resource "aws_kms_alias" "alerts" {
  name          = "alias/mythrun-alerts"
  target_key_id = aws_kms_key.alerts.key_id
}
