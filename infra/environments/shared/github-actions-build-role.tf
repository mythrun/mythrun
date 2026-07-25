# ======== GitHub Actions BUILD role (myth-jnb) ========
#
# The image-build half of CI, split out of mythrun-github-actions-staging.
#
# THE PROBLEM THIS SOLVES. The single staging role carries ECR push AND
# ecs:UpdateService AND iam:PassRole. The build job's whole purpose is to run
# untrusted-ish third-party code — a pinned action, a pnpm postinstall script, a
# Dockerfile's RUN lines — with AWS credentials in the environment. Anything
# that compromises one step of that job today inherits the authority to roll a
# new task definition into the running cluster. Splitting the roles means a
# compromised build can push a bad image and nothing more; something still has
# to choose to deploy it. For staging alone the blast radius made that
# acceptable; for production it does not, which is why this must land before the
# production deploy job is enabled.
#
# WHY THIS ROLE LIVES IN THE SHARED WORKSPACE. It is environment-agnostic by
# construction: it pushes to the two ECR repositories declared in this
# workspace, and the images it produces are the same images every environment
# deploys. Declaring it here means the production composition inherits one build
# role rather than minting a second one with the same permissions.
#
# ---- THIS ROLE IS NOT WIRED UP YET ----
#
# Creating it changes nothing on its own — no workflow assumes it. The cutover
# is a sequence, and doing it out of order breaks every deploy:
#
#   1. Apply this workspace. The role appears; CI keeps using the staging role.
#   2. In GitHub: Settings -> Environments -> New environment named `build`.
#      No required reviewers (it gates nothing; it exists to scope the OIDC
#      `environment` claim). Set its deployment branch rule to `main`, and add
#      an environment variable AWS_ACCOUNT_ID with the account number — the
#      build job reads `vars.AWS_ACCOUNT_ID`, which is environment-scoped, so
#      it comes back EMPTY under a new environment that lacks it.
#   3. Change the build jobs to `environment: build` and to assume
#      `mythrun-github-actions-build`: the `build` job in deploy.yml and the
#      `build-and-push` job in bootstrap-db-build.yml. Push, and confirm a real
#      run goes green.
#   4. Only then set github_build_role_cutover = true in the STAGING workspace
#      and apply it, which strips ECR push from the staging role.
#
# Step 4 before step 3 breaks the build. Step 3 before step 1 or 2 breaks the
# build. The gate variable exists so each half is separately revertible.

data "aws_iam_policy_document" "gh_actions_build_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository"
      values   = ["mythrun/mythrun"]
    }

    # Numeric repo ID: immune to both repo-rename and org-rename/reclaim.
    # See the long historical note on the staging role's trust policy.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:repository_id"
      values   = [var.github_repository_id]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:environment"
      values   = ["build"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = ["refs/heads/main"]
    }

    # AWS requires the trust policy to pin `:sub` specifically — it rejects a
    # policy where that key is absent or matched only by a wildcard. GitHub
    # composes it as "repo:<owner>/<name>:environment:<env>", so this is
    # redundant with the conditions above, but the check is structural.
    #
    # LANDMINE, for whoever touches this next: GitHub's immutable-subject-claim
    # rollout reformats `sub` to embed numeric IDs
    # ("repo:mythrun@<owner-id>/mythrun@<repo-id>:environment:build"). It is
    # automatic for repositories created after 2026-07-15 and is ALSO triggered
    # by renaming or transferring an existing repository. mythrun/mythrun
    # predates that date, so the classic format holds — but a rename would
    # silently invalidate this line while `repository_id`, `environment`, and
    # `ref` keep working. If OIDC assume starts failing with "Not authorized to
    # perform sts:AssumeRoleWithWebIdentity" right after a repo rename, this is
    # why.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:mythrun/mythrun:environment:build"]
    }

    # myth-651: pin the workflow file itself. Off by default — see the variable's
    # description for why this cannot be enabled blind.
    dynamic "condition" {
      for_each = var.pin_job_workflow_ref ? [1] : []
      content {
        test     = "StringEquals"
        variable = "token.actions.githubusercontent.com:job_workflow_ref"
        values   = local.build_job_workflow_refs
      }
    }
  }
}

locals {
  # Every workflow whose jobs are allowed to assume the build role. StringEquals
  # against a list is an OR, so adding a build workflow means adding a line here
  # — which is the point: a new workflow file cannot quietly mint images.
  build_job_workflow_refs = [
    "mythrun/mythrun/.github/workflows/deploy.yml@refs/heads/main",
    "mythrun/mythrun/.github/workflows/bootstrap-db-build.yml@refs/heads/main",
  ]
}

resource "aws_iam_role" "github_actions_build" {
  name               = "mythrun-github-actions-build"
  assume_role_policy = data.aws_iam_policy_document.gh_actions_build_trust.json

  tags = { Name = "mythrun-github-actions-build" }
}

# ECR and nothing else. No ECS, no PassRole, no S3, no CloudFront.
data "aws_iam_policy_document" "gh_actions_build" {
  # ECR auth token — account-wide by AWS design; it cannot be ARN-scoped.
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Push + pull on the two repositories CI builds into, plus the pull-through
  # cache namespace the Dockerfile's base image is fetched from.
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = [
      aws_ecr_repository.mythrun.arn,
      aws_ecr_repository.bootstrap_db.arn,
      "arn:aws:ecr:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:repository/ecr-public/*",
    ]
  }

  # Pull-through cache: the first pull of a given base image auto-creates its
  # cache repository and triggers the upstream fetch. Without these two, that
  # first `docker pull` fails at ECR authorization. Scoped to the ecr-public/*
  # prefix set by aws_ecr_pull_through_cache_rule.ecr_public.
  statement {
    actions = [
      "ecr:CreateRepository",
      "ecr:BatchImportUpstreamImage",
    ]
    resources = [
      "arn:aws:ecr:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:repository/ecr-public/*",
    ]
  }
}

resource "aws_iam_role_policy" "github_actions_build" {
  name   = "ecr-push"
  role   = aws_iam_role.github_actions_build.id
  policy = data.aws_iam_policy_document.gh_actions_build.json
}
