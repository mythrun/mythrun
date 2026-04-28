# syntax=docker/dockerfile:1
# ARG must precede FROM and is FROM-scope only by Docker semantics — no
# default; the build pipeline supplies it. A typo at build time fails loudly
# at FROM (the URL doesn't resolve to an alpine repo).
ARG ECR_ACCOUNT_ID

FROM ${ECR_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/ecr-public/docker/library/alpine:3.20

# - bash: bootstrap-databases.sh uses bash-only syntax (set -uo pipefail, [[ ]])
# - aws-cli: on alpine 3.20 the `aws-cli` package IS v2 (verified 2.15.57
#   at image build). There is no separate `aws-cli-v2` package on this
#   release. We want v2 specifically (faster start, current AWS
#   stewardship); the smoke-check `RUN` below fails the build if alpine
#   ever shuffles `aws-cli` back to v1 — that's a regression we want to
#   notice loudly, not silently inherit.
# - postgresql16-client: psql to RDS (matches RDS engine major)
# - jq: parse master-secret JSON
# - ca-certificates: TLS to AWS APIs and rds.force_ssl=1
# Versions intentionally unpinned beyond major. Image lifecycle keeps the
# last 20; alpine 3.20 minor security bumps are a feature, not a regression
# risk, on a manually-invoked operator task that never runs unattended.
# hadolint ignore=DL3018
RUN apk add --no-cache \
      bash \
      aws-cli \
      postgresql16-client \
      jq \
      ca-certificates

# Belt-and-suspenders: fail the build if the apk repo ever drifts and gives
# us v1 under this package name. Also prints the version into build logs
# for forensic clarity.
RUN aws --version 2>&1 | tee /dev/stderr | grep -q 'aws-cli/2'

WORKDIR /app
COPY infra/scripts/bootstrap-databases.sh /app/bootstrap-databases.sh
RUN chmod +x /app/bootstrap-databases.sh

# CMD intentionally unset — the ECS run-task --overrides supplies the args.
# ENTRYPOINT is the script so the operator's --overrides is just
# ["--env","staging","--verify"].
ENTRYPOINT ["/bin/bash", "/app/bootstrap-databases.sh"]
