# Onboarding: Fresh Claude Instance

> **Read this first.** You are starting work on the production implementation of Mythrun. This document tells you what Mythrun is, what state the project is in, and what to do next.

## What is Mythrun?

A multiplayer AI Dungeon Master that runs D&D 5e campaigns. Players describe a world concept ("a dying kingdom where the sun hasn't risen in a hundred years"), an AI generates the complete setting in minutes, players create characters, and then play D&D in real-time with an AI DM that handles narrative, skill checks, and tactical combat.

**Product targets:**
- 2-5 players per campaign, text-based multiplayer chat
- Full 5e combat engine with AI-generated voxel battle maps
- Session-pack billing via Stripe (owner pays, players join free)
- 200-500 concurrent sessions at launch

## Current State

**The design is complete.** There are 11+ detailed specs in `docs/specs/` covering every layer of the system, from AWS infrastructure to the combat rules engine. The specs have been through a six-team architectural audit and incorporated 14 targeted fixes.

**No production code has been written yet.** This repo is essentially empty. Your job is to implement from the specs.

A working single-player prototype exists at `/Users/miklos/Desktop/Files/Personal/mythrun-v5/` that validated the core mechanics. It is reference-only — the production codebase is a clean rewrite against a new schema, multiplayer architecture, and production infrastructure. **Do not read the prototype code unless you have a specific question about a validated behavior.**

## Reading Order

Do NOT try to read all specs at once. Read them in dependency order as you need them:

### Always read first
1. `CLAUDE.md` (this repo root) — project rules, ZFC principle, workflow conventions
2. `docs/specs/2026-04-06-production-architecture-overview.md` — the system topology, data model, interface contracts. This is the "constitution" — every other spec conforms to it.

### Then read when relevant to your current task

| Working on... | Read |
|--------------|------|
| AWS setup, Terraform, CI/CD | `2026-04-07-week0-ops-foundation.md` + `2026-04-10-infrastructure-devops.md` + `2026-04-20-setup-guide.md` |
| Database schema, async Postgres, repository layer, server skeleton | `2026-04-13-backend-core.md` |
| OAuth, JWT, user registration, invite system | `2026-04-13-auth-users.md` |
| Stripe, credit ledger, session packs, subscriptions | `2026-04-13-billing-cost-controls.md` |
| World gen pipeline, character creation, BullMQ jobs | `2026-04-13-world-campaign-pipeline.md` |
| Live play, WebSockets, SessionController, Fast/Slow Thinker, Scribe | `2026-04-13-multiplayer-session-runtime.md` |
| Combat system, voxel maps, rules engine | `2026-04-13-combat-engine.md` |
| Frontend design, onboarding UX, chat UI, combat UI | `2026-04-10-ux-design.md` |

### Supplementary reading (optional but useful)

- `2026-04-13-fun-report.md` — game designers' take on the product. Good for understanding the "feel" we're going for.
- `2026-04-13-system-design-interview-transcript.md` — mock interview that evaluated the architecture. Useful context for why some decisions were made.

## Workflow

### Task Tracking (Beads — Setup Required)

This repo does not yet have Beads (`bd`) set up. The prototype used Beads for task tracking and it worked well — you'll likely want the same. The user may also be evaluating alternative tools like Gas Town. Either way, set up the task tracking system before starting implementation work.

Until a tracker is configured, the user will coordinate tasks verbally.

### Implementation Phases (Approximate Order)

Work implements the specs in this dependency order:

**Phase 0: Foundation**
1. Week 0 (Ops Foundation): AWS account setup, Terraform state backend, VPC, secrets, CI/CD pipeline, first deployed health-check container
2. Infrastructure & DevOps: ECS services, RDS, Redis, full AWS topology via Terraform

**Phase 1: Backend core**
3. Backend Core: Postgres schema + migrations, async repository, Fastify server skeleton

**Phase 2: Platform features (can parallelize some)**
4. Auth & Users: Cognito integration, JWT middleware, username registration, invites
5. Billing & Cost Controls: Stripe integration, credit ledger, subscription tiers, session packs

**Phase 3: Game features**
6. World & Campaign Pipeline: Port prompt templates, build the two pipelines on BullMQ, implement world forking
7. Multiplayer Session Runtime: Transient SessionController, WebSocket + Redis pub/sub, DM trigger, Fast/Slow Thinker, Scribe — the biggest piece
8. Combat Engine Layer 1: Debug shell (text-based combat resolution)
9. Combat Engine Layer 2: Full 5e rules engine + voxel maps (biggest single component)

**Phase 4: Frontend**
10. Frontend: New design system, onboarding flow, multiplayer chat UI, combat UI

**Phase 5: Hardening**
11. Observability & Hardening: Structured logging, metrics, alarms, rate limiting, security headers

### Before Starting Implementation

The first session of real work should start with the **Setup Guide** (`docs/specs/2026-04-20-setup-guide.md`). Phase 1 of that guide is the user's responsibility (AWS account security, IAM Identity Center, tool installation). Phase 2+ is where you (Claude) take over with Terraform modules, Dockerfile, CI/CD workflow, etc.

## Who You're Working With

- **Miklos** is the solo developer. He has design vision and makes all product decisions. He is new to infrastructure and DevOps — explain concepts when they come up.
- **His email** is miklos.bowling@gmail.com.
- **Working style**: Prefers getting to action. Wants trade-offs presented clearly with recommendations. Will ask for clarification on technical topics he's unfamiliar with. Has strong game design instincts and won't tolerate compromises on product quality (e.g., AI-generated voxel maps are non-negotiable, no template fallback).
- **Critical rule**: ZFC. He specifically pushed back on regex-based classification during design and wants Haiku calls for all semantic judgments. Internalize this.

## What You Should NOT Do

- **Do not read the prototype code** at `/Users/miklos/Desktop/Files/Personal/mythrun-v5/`. The specs capture everything you need. Reading prototype code will pollute your mental model with the single-player architecture.
- **Do not invent behavior not in the specs.** The specs were written carefully and audited. If something seems missing, ask before improvising.
- **Do not skip the TDD loop.** Write failing tests that define "done" before implementation.
- **Do not rush to implementation.** Understanding before coding is the rule.

## Attribution

All commits are authored by Miklos (using his git config). When you contribute via AI pair programming, include a `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer in the commit message. This is the standard git co-author convention — GitHub will display both avatars on the commit.

## First Session Checklist

If this is the very first implementation session:
1. Read this onboarding doc ✓
2. Read `CLAUDE.md`
3. Read the Architecture Overview spec
4. Read the Setup Guide
5. Ask Miklos where he's at in the Setup Guide's Phase 1 (AWS account security, tool installation)
6. When he's ready, start Phase 2 (create the project structure) together
