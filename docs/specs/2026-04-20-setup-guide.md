# Mythrun Setup Guide: Blank AWS Account to First Deployed Container

> **Audience**: Solo developer with an AWS account login and nothing else, working with Claude (AI) as a pair programmer
> **End state**: A health-check container running on ECS Fargate, reachable via HTTPS at your custom domain, deployed via GitHub Actions
> **Time estimate**: 4-6 hours of focused work (not counting waiting for DNS propagation)
> **Last verified**: 2026-04-20 against current AWS, Terraform, GitHub Actions, and Node.js documentation

## Who Does What

This guide assumes Miklos (the solo dev) and Claude (AI pair programmer) are working together. The work splits cleanly:

**Miklos does (Phase 1):**
- AWS console security work (IAM Identity Center, MFA, billing)
- Installing local tools
- Anything requiring his personal credentials or authorization to spend money

**Claude does (Phase 2 onwards):**
- Writing all Terraform modules
- Writing the Dockerfile, server code, CI/CD workflow
- Running the bootstrap bash commands (with approval)
- Local testing

**Miklos approves:**
- Any `terraform apply` (real infrastructure changes)
- Any SSO sign-in
- Any deploy that hits production

**Attribution:** All commits are authored by Miklos. Claude is credited via `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` trailers. This is the [standard git co-author convention](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors) — GitHub shows both avatars on the commit.

---

## Prerequisites (Install on Your Machine)

Before touching AWS, install these tools locally:

### 1. Homebrew (if on Mac)
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. AWS CLI v2
```bash
brew install awscli
aws --version  # should print aws-cli/2.x.x
```

### 3. Terraform
```bash
brew install terraform
terraform --version  # should print Terraform v1.x.x
```

**Note on licensing**: Terraform uses the Business Source License (BUSL). This is effectively open-source for our use case (we're not competing with HashiCorp's hosted products). OpenTofu is a community fork under MPL if you ever want to switch — it's a drop-in replacement.

### 4. Docker Desktop
Download from https://www.docker.com/products/docker-desktop/ — you need this for building container images locally and for Docker Compose (local dev).

Docker Desktop is free for individuals, companies under 250 employees AND under $10M revenue, education, and non-commercial open source. Mythrun qualifies.

After install, verify:
```bash
docker --version
docker compose version
```

### 5. Node.js 24 + pnpm
Node 24 is the current Active LTS (as of April 2026). Use it for new projects.

```bash
brew install node@24
corepack enable
pnpm --version  # should print 10.x
```

**Corepack note**: If you get signature validation errors with pnpm, update corepack first: `npm install -g corepack@latest`. This is a known gotcha with older corepack versions.

### 6. GitHub CLI (optional but helpful)
```bash
brew install gh
gh auth login
```

---

## Phase 1: AWS Account Setup

**This is the one phase where Miklos works solo — Claude cannot and should not do security-sensitive console work.**

### Step 1.1: Secure Your Root Account

Your root account (the email you signed up with) has unlimited power. Secure it immediately.

1. Log into the AWS Console at https://console.aws.amazon.com
2. Search for **IAM** in the top bar
3. On the IAM dashboard, find the "Security recommendations" section and click **"Add MFA"** on the root account
4. AWS now strongly recommends **phishing-resistant MFA**. Your options, in order of preference:
   - **Passkey** (e.g., built into your phone/laptop — Face ID, Touch ID, Windows Hello) — best option
   - **Hardware security key** (YubiKey) — best if you have one
   - **Authenticator app** (Google Authenticator, Authy, 1Password) — acceptable fallback
5. Never use the root account for daily work after this step. Going forward, you'll use IAM Identity Center.

### Step 1.2: Enable IAM Identity Center

AWS no longer recommends creating long-lived IAM users for human access. Instead, you use **IAM Identity Center** (formerly AWS SSO) which issues short-lived credentials automatically refreshed by the CLI.

1. In the AWS Console, search for **IAM Identity Center**
2. Click **Enable** (if not already enabled)
3. AWS will create an AWS Organization for you if one doesn't exist — that's fine, this is standard
4. Note the **AWS access portal URL** shown (looks like `https://d-xxxxxxxxxx.awsapps.com/start`). Save this — you'll need it.

### Step 1.3: Create Your Identity Center User

1. In IAM Identity Center, go to **Users** → **Add user**
2. Username: `miklos` (or whatever you want)
3. Email: your real email address
4. First/last name: your real name
5. Click Next → Skip groups for now → Create user
6. AWS will send an invitation email. Open it, accept, and set a password + MFA (same phishing-resistant MFA as Step 1.1).

### Step 1.4: Create a Permission Set

Permission sets define what your user can do when signed in.

1. In IAM Identity Center, go to **Permission sets** → **Create permission set**
2. Choose **Predefined permission set** → **AdministratorAccess**
3. Name: `AdminAccess`
4. Session duration: 12 hours (a reasonable default for solo dev work)
5. Click Next → Create

### Step 1.5: Assign the Permission Set to Your Account

1. In IAM Identity Center, go to **AWS accounts**
2. Check the box next to your AWS account (there's only one — your management account)
3. Click **Assign users or groups** → select your user (`miklos`)
4. Click Next → select `AdminAccess` permission set → Next → Submit

After a minute, your user has admin access to your account via SSO.

### Step 1.6: Configure AWS CLI with SSO

```bash
aws configure sso
```

You'll be prompted for:
- **SSO session name**: `mythrun` (or whatever you want)
- **SSO start URL**: paste the AWS access portal URL from Step 1.2
- **SSO region**: `us-east-1`
- **SSO registration scopes**: press Enter (accept default `sso:account:access`)

A browser will open. Sign in with your Identity Center user, approve the CLI access request. Back in the terminal:
- **CLI default client Region**: `us-east-1`
- **CLI default output format**: `json`
- **CLI profile name**: `mythrun` (or accept the default — this becomes the profile name you use)

Verify it works:
```bash
aws sts get-caller-identity --profile mythrun
```

Should print your account ID and user ARN. If the session expires later, just run:
```bash
aws sso login --profile mythrun
```

**For the rest of this guide**, all `aws` commands use this profile. You can either:
- Pass `--profile mythrun` to every command, OR
- Set `export AWS_PROFILE=mythrun` in your shell

### Step 1.7: Set Up Billing Alerts

1. In the AWS Console, go to **AWS Billing and Cost Management**
2. Click **Budgets** → **Create budget**
3. Choose **"Monthly cost budget"**
4. Set amount: `$200` (or your comfort level)
5. Add alert threshold: 80% → email notification to your address
6. Add another: 100% → email notification
7. Create

Also:
1. Go to **Billing and Cost Management** → **Billing preferences** (in the left nav)
2. Enable **"Receive Free Tier Usage Alerts"**
3. Enter your email

---

## Phase 2: Create the GitHub Repo

### Step 2.1: Create the Repo (in the Mythrun org)

The new production repo lives in the Mythrun GitHub organization, not on your personal user. This is the correct home for the project — it scales as the company grows and transfers cleanly if needed.

```bash
gh repo create mythrun/mythrun --private --clone
cd mythrun
```

Or via github.com: Switch to the Mythrun org → New repository → `mythrun` → Private → Create → Clone locally.

### Step 2.2: Initialize the Project Structure

```bash
mkdir -p backend/src backend/tests infra/modules infra/environments/staging infra/environments/production
touch backend/package.json backend/tsconfig.json backend/Dockerfile
touch infra/environments/staging/main.tf infra/environments/production/main.tf
touch docker-compose.yml .gitignore .env.development.example pnpm-workspace.yaml
```

### Step 2.3: Set Up .gitignore

```bash
cat > .gitignore << 'EOF'
node_modules/
dist/
*.env
.env.*
!.env.*.example
*.db
.terraform/
*.tfstate
*.tfstate.backup
.terraform.lock.hcl
EOF
```

### Step 2.4: Initial Commit

```bash
git add .
git commit -m "chore: initialize project structure"
git push -u origin main
```

---

## Phase 3: Bootstrap Terraform State Backend

> **Work split**: Claude runs these commands via Bash (Miklos approves each). The commands are safe and idempotent — they create AWS resources but nothing costs money until used.

Terraform needs somewhere to store its state file. This is the one thing created BEFORE Terraform manages everything else.

### Step 3.1: Create S3 Bucket for State

```bash
aws s3 mb s3://mythrun-terraform-state --region us-east-1

aws s3api put-bucket-versioning \
  --bucket mythrun-terraform-state \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block \
  --bucket mythrun-terraform-state \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
```

**Note**: AWS now enables SSE-S3 (AES256) encryption by default on all new buckets (since January 2023). No need to set it explicitly.

### Step 3.2: State Locking (No DynamoDB Needed)

Terraform used to require a DynamoDB table for state locking. As of Terraform 1.10+, **DynamoDB-based locking is deprecated**. The new approach uses native S3 locking — Terraform writes a `.tflock` file to the same bucket as the state. No separate resource needed.

You'll configure this in the backend block in Step 4.1 via `use_lockfile = true`.

### Step 3.3: Verify

```bash
aws s3 ls | grep mythrun
aws s3api get-bucket-versioning --bucket mythrun-terraform-state
```

The first should show the bucket. The second should show `"Status": "Enabled"`.

You now have a place for Terraform to store its state with native locking.

---

## Phase 4: Write Terraform Infrastructure

> **Work split**: Claude writes all Terraform modules. Miklos reviews `terraform plan` output and approves `terraform apply`.

This is where the bulk of Week 0 work happens. Terraform modules for the VPC, ECS, ALB, etc. get written here.

### Step 4.1: Configure the Backend

Create `infra/environments/staging/backend.tf`:
```hcl
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    bucket       = "mythrun-terraform-state"
    key          = "environments/staging/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "mythrun"
}
```

**Version notes**:
- `required_version = ">= 1.10.0"` — needed for `use_lockfile` support
- AWS provider `~> 6.0` — v6 is current as of April 2026. Note that v6.0.0 had breaking changes from v5; we're starting fresh so this is fine.
- `profile = "mythrun"` — tells Terraform to use the SSO profile you configured

### Step 4.2: Write the Terraform Modules

The modules to write (per Week 0 + Infra specs):

1. **`infra/modules/network/`** — VPC, subnets (public/private across 2 AZs), Internet Gateway, NAT Gateway, route tables, security groups
2. **`infra/modules/compute/`** — ECS cluster, ECR repository, ECS task definitions, ECS services (API + Worker), IAM roles (task execution role, task role), GitHub Actions OIDC provider + role
3. **`infra/modules/data/`** — RDS Postgres instance + RDS Proxy, ElastiCache Redis (real-time + batch), Secrets Manager entries, DB subnet groups, parameter groups
4. **`infra/modules/observability/`** — CloudWatch log groups, SNS topic, critical alarms, ALB + target group + listener + ACM certificate, S3 bucket for frontend, CloudFront distribution, Route 53 records

Each module has: `main.tf` (resources), `variables.tf` (inputs), `outputs.tf` (outputs for other modules to reference).

The staging `main.tf` calls all modules with staging-sized parameters.

**This is the largest Claude-authored chunk.** Writing Terraform is mechanical once you know what you want — and the specs define exactly what we want.

### Step 4.3: Apply

```bash
cd infra/environments/staging
terraform init
terraform plan    # review what will be created
terraform apply   # create everything (type 'yes' to confirm)
```

This creates your VPC, subnets, ECS cluster, database, Redis, load balancer, DNS records — everything.

---

## Phase 5: Build and Deploy the First Container

> **Work split**: Claude writes the server code, Dockerfile, and CI/CD workflow. Claude tests locally via Docker. Miklos approves the first push to GitHub (which triggers the real deploy).

### Step 5.1: Write the Minimal App

`backend/src/server.ts`:
```typescript
import Fastify from 'fastify'

const app = Fastify({ logger: true })

app.get('/health', async () => ({ status: 'ok' }))

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
```

`backend/Dockerfile`:
```dockerfile
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY src/ src/
COPY tsconfig.json ./
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### Step 5.2: Test Locally

```bash
cd backend
pnpm install
pnpm build
docker build -t mythrun .
docker run -p 3000:3000 mythrun
# In another terminal:
curl http://localhost:3000/health
# Should return: {"status":"ok"}
```

### Step 5.3: Set Up GitHub Actions

`.github/workflows/deploy.yml`:
```yaml
name: Build and Deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write   # Required for OIDC
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter backend lint
      - run: pnpm --filter backend typecheck
      - run: pnpm --filter backend test
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/mythrun-github-actions
          aws-region: us-east-1
      
      - name: Login to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      
      - name: Build and push image
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $REGISTRY/mythrun:$IMAGE_TAG -t $REGISTRY/mythrun:latest backend/
          docker push $REGISTRY/mythrun:$IMAGE_TAG
          docker push $REGISTRY/mythrun:latest

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: us-east-1
      
      # Register a new task def revision pointing at the just-pushed image,
      # then update the service to use it. `--force-new-deployment` alone does
      # NOT switch task-def revisions — the `--task-definition` flag is
      # load-bearing. Recommend using aws-actions/amazon-ecs-deploy-task-definition
      # which handles the describe→patch→register→update flow correctly
      # (stripping read-only fields, etc.).
      - name: Deploy to ECS staging
        run: |
          # Detailed runbook in bead myth-bcx; abridged sequence here.
          TASK_DEF=$(aws ecs describe-task-definition \
            --task-definition mythrun-staging-api \
            --query 'taskDefinition' --output json \
            | jq 'del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)' \
            | jq --arg img "$IMAGE_URI" '.containerDefinitions[0].image = $img')
          NEW_REV=$(aws ecs register-task-definition --cli-input-json "$TASK_DEF" --query 'taskDefinition.revision' --output text)
          aws ecs update-service \
            --cluster mythrun \
            --service mythrun-staging-api \
            --task-definition mythrun-staging-api:$NEW_REV \
            --desired-count 1 \
            --force-new-deployment
      
      - name: Wait for stability
        run: |
          aws ecs wait services-stable \
            --cluster mythrun \
            --services mythrun-staging-api

  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: production  # Requires manual approval
    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-production
          aws-region: us-east-1
      
      # Same register-then-update pattern as staging; cluster is shared.
      - name: Deploy to ECS production
        run: |
          TASK_DEF=$(aws ecs describe-task-definition \
            --task-definition mythrun-production-api \
            --query 'taskDefinition' --output json \
            | jq 'del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)' \
            | jq --arg img "$IMAGE_URI" '.containerDefinitions[0].image = $img')
          NEW_REV=$(aws ecs register-task-definition --cli-input-json "$TASK_DEF" --query 'taskDefinition.revision' --output text)
          aws ecs update-service \
            --cluster mythrun \
            --service mythrun-production-api \
            --task-definition mythrun-production-api:$NEW_REV \
            --force-new-deployment
      
      - name: Wait for stability
        run: |
          aws ecs wait services-stable \
            --cluster mythrun \
            --services mythrun-production-api
```

**Amended 2026-04-22 (MYT-30 serving-infra design):** Cluster and service names corrected — there is a single shared cluster `mythrun` (not per-env `mythrun-staging`/`mythrun-production`) with per-env services `mythrun-staging-api` / `mythrun-production-api`. GitHub Actions role names are per-env (`mythrun-github-actions-staging` / `mythrun-github-actions-production`) for least-privilege scoping. Deploy step uses register-then-update (not `--force-new-deployment` alone) because the latter doesn't switch task-def revisions.

**Action versions are current as of April 2026**: `configure-aws-credentials@v6`, `setup-node@v6`, `pnpm/action-setup@v4`, `amazon-ecr-login@v2`.

### Step 5.4: Push and Watch

```bash
git add .
git commit -m "feat: initial health check server with CI/CD"
git push
```

Go to GitHub → Actions tab → watch the build run. If it succeeds, hit:
```bash
curl https://staging-api.mythrun.com/health
```

If you see `{"status":"ok"}` — you're live.

---

## Phase 6: Set Up Local Dev Environment

> **Work split**: Claude writes all the config files. Miklos runs `docker compose up -d` and fills in the real API keys in `.env.development`.

Once the cloud infra is running, set up the daily development workflow:

### Step 6.1: Docker Compose for Local Postgres + Redis

`docker-compose.yml` (at repo root):
```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: mythrun
      POSTGRES_PASSWORD: mythrun_dev
      POSTGRES_DB: mythrun
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis-realtime:
    image: redis:7.2-alpine
    ports:
      - "6379:6379"

  redis-batch:
    image: redis:7.2-alpine
    ports:
      - "6380:6379"

volumes:
  pgdata:
```

### Step 6.2: Environment File

`.env.development.example`:
```
DATABASE_URL=postgresql://mythrun:mythrun_dev@localhost:5432/mythrun
REDIS_REALTIME_URL=redis://localhost:6379
REDIS_BATCH_URL=redis://localhost:6380
ANTHROPIC_API_KEY=sk-ant-xxx
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
AUTH_MODE=bypass
PORT=3000
```

Copy to `.env.development` and fill in your real keys.

### Step 6.3: Daily Commands

```bash
docker compose up -d              # start Postgres + Redis (once)
pnpm dev                          # start backend with hot reload
# ... write code ...
pnpm test                         # run tests
git push                          # triggers deploy to staging
```

---

## Checklist Summary

```
[ ] Install: AWS CLI v2, Terraform, Docker, Node 24, pnpm
[ ] AWS: Secure root account with phishing-resistant MFA
[ ] AWS: Enable IAM Identity Center
[ ] AWS: Create Identity Center user
[ ] AWS: Create AdministratorAccess permission set
[ ] AWS: Assign permission set to your account
[ ] AWS: Configure CLI with aws configure sso
[ ] AWS: Set billing alerts ($200 budget)
[ ] GitHub: Create mythrun/mythrun repo in Mythrun org (private)
[ ] Bootstrap: Create S3 state bucket
[ ] Bootstrap: Verify bucket versioning enabled
[ ] Terraform: Write network module (VPC, subnets, NAT, SGs)
[ ] Terraform: Write compute module (ECS, ECR, IAM, OIDC)
[ ] Terraform: Write data module (RDS, Redis, Secrets)
[ ] Terraform: Write observability module (ALB, CloudFront, DNS, logs)
[ ] Terraform: terraform apply (staging)
[ ] App: Write minimal health check server
[ ] App: Write Dockerfile (Node 24), test locally
[ ] CI/CD: Write GitHub Actions workflow (v6 actions)
[ ] CI/CD: Push, verify deploy succeeds
[ ] Verify: curl https://staging-api.mythrun.com/health → 200
[ ] Local: Set up docker-compose.yml
[ ] Local: Create .env.development
[ ] Celebrate: You have production infrastructure 🎉
```

---

## What Comes After

Once the health check is deployed:
1. Add Postgres connection + migration runner + schema
2. Add Redis connection
3. Add auth middleware (Cognito)
4. Add first real routes
5. Add billing (Stripe)
6. Port pipeline logic
7. Add multiplayer session runtime
8. Add combat (debug shell)
9. Build frontend

Each step is a PR that deploys to staging, gets verified, then promoted to production. Incremental, safe, always-deployable.
