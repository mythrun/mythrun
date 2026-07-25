# ======== Account cost budget (myth-57l) ========
#
# THIS RESOURCE ALREADY EXISTS IN AWS. It was created by hand in the console
# before it was codified here, so it must be IMPORTED, not applied:
#
#   terraform import aws_budgets_budget.monthly_cost \
#     "$(aws sts get-caller-identity --query Account --output text):Monthly Cost Budget"
#
# Then run `terraform plan` and confirm it reports NO changes to this resource
# before applying anything else. The configuration below was reconstructed from
# the budget's documented shape, not read off the live account, so a field or
# two may differ (cost_types and time_period_start are deliberately omitted —
# both are Optional+Computed in the AWS provider, so the imported values stand
# and produce no diff). If the plan does show a diff, reconcile the HCL to match
# what is live rather than letting the apply rewrite a working budget.
#
# Applying WITHOUT importing first is not destructive: AWS rejects a duplicate
# budget name with DuplicateRecordException and the apply fails loudly.
#
# WHY BUDGETS AND NOT A CLOUDWATCH ALARM. Week 0 §6.3 lists "AWS account spend"
# alongside the operational alarms, and the natural instrument would be an alarm
# on AWS/Billing EstimatedCharges. That metric does not exist in this account —
# it is only published once the "Receive Billing Alerts" account preference is
# switched on, and it only ever lands in us-east-1. AWS Budgets needs no such
# preference, evaluates forecasts as well as actuals, and is the vehicle AWS
# itself now points at. Spend is therefore NOT one of the CloudWatch alarms in
# alarms.tf; it is this.

resource "aws_budgets_budget" "monthly_cost" {
  # Name is load-bearing: it is half the import ID and AWS treats it as the
  # budget's identity. Renaming it destroys and recreates the budget.
  name = "Monthly Cost Budget"

  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Three notifications, matching what is live. They are deliberately layered
  # rather than redundant:
  #
  #   85% ACTUAL      — "you are on an unusual trajectory", with enough of the
  #                     month left to do something about it.
  #   100% FORECASTED — AWS's own projection says this month ends over budget.
  #                     Usually fires BEFORE the 85% actual on a sharp ramp,
  #                     which is exactly the case worth catching early: a
  #                     runaway LLM spend does not creep, it steps.
  #   100% ACTUAL     — the line has been crossed. Not preventive; this one is
  #                     the record that it happened.
  #
  # All three notify by email only. Routing them to the mythrun-shared-alerts
  # SNS topic instead of (or in addition to) email is a live decision — the
  # topic policy in alarms.tf already authorizes budgets.amazonaws.com to
  # publish, so that change is additive and works when someone wants it.

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 85
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alerts_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alerts_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alerts_email]
  }
}
