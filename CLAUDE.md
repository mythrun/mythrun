# Mythrun — AI-Powered D&D (Production)

> **Status**: Implementation in progress. All specs complete. No production code yet.
> **Start here**: Read `ONBOARDING.md` first if you're a fresh Claude instance.

A multiplayer AI Dungeon Master that runs D&D 5e campaigns. The AI DM generates worlds, drives narrative, manages combat, and remembers everything across sessions. Target: 200-500 concurrent play sessions at launch.

## Tech Stack (Production Target)

- **Backend**: Node.js 24 + Fastify + TypeScript (strict), Postgres, Redis, BullMQ
- **Frontend**: React + Vite + Tailwind + Three.js (for combat maps)
- **LLM**: Anthropic API — Sonnet for Fast Thinker, Opus for Slow Thinker, Haiku for routing/classification
- **Infra**: AWS (ECS Fargate, RDS Postgres, ElastiCache Redis, ALB, Cognito, S3/CloudFront) via Terraform
- **Auth**: Cognito + Google/Discord OAuth
- **Billing**: Stripe (session packs + subscription tiers)
- **Test**: Vitest | Lint: ESLint | Package manager: pnpm

## Architecture

The system has four cognitive tiers plus an offline prep engine. See `docs/specs/2026-04-06-production-architecture-overview.md` for the full design. The short version:

- **Fast Thinker** (Sonnet) — player-facing prose. Operates under ENFORCED IGNORANCE: no plot knowledge, no NPC secrets, no campaign arcs.
- **Slow Thinker** (Opus) — narrative director. Evaluates each turn, injects stage directions when intervention is needed. Sees everything.
- **Scribe** (Sonnet) — post-turn extractor. Updates world state based on what happened.
- **DM Trigger Classifier** (Haiku) — decides when the DM should respond in multiplayer chat, with confidence-based escalation to the Slow Thinker.
- **Prep Engine** (Opus) — offline world generator. Takes freeform human input, produces prose kernels + structured facts for the world store.

## Specs Are the Source of Truth

All implementation work follows the spec suite in `docs/specs/`. The specs are the output of months of design and a six-team architecture audit. They are detailed enough to implement from directly.

**Read specs in dependency order:**
1. Architecture Overview (system topology, data model, interface contracts)
2. Week 0: Ops Foundation (VPC, secrets, CI/CD)
3. Infrastructure & DevOps (ECS, RDS, Redis config)
4. Backend Core (schema, repository, server skeleton)
5. Auth & Users (Cognito, JWT, invites)
6. Billing & Cost Controls (Stripe, credits)
7. World & Campaign Pipeline (prep engine)
8. Multiplayer Session Runtime (the live play system)
9. Combat Engine (rules + voxel maps)
10. UX Design (frontend design system)

The setup guide (`docs/specs/2026-04-20-setup-guide.md`) is your blank-AWS-account-to-first-deployed-container checklist. That's where implementation starts.

## Non-Negotiable Principles

1. **Enforced ignorance is a hard boundary, not a prompting suggestion.** If code passes plot information to a Fast Thinker call, that is a bug. The FT only sees public facts. The FT never sees why the ST intervened.
2. **Zero Framework Cognition (ZFC).** Application code is pure orchestration — a thin, deterministic shell. ALL reasoning, classification, semantic analysis, and judgment calls are delegated to AI models (Haiku for cheap/fast decisions, Sonnet/Opus for complex ones). No heuristics, no keyword-based routing, no pattern matching on LLM output, no local intelligence. Exceptions: explicit UI commands (like `@DM`), structural validation (schema checks), mechanical computation (dice math, movement ranges), policy enforcement (rate limits, budget caps). When in doubt, call Haiku. See: https://steve-yegge.medium.com/zero-framework-cognition-a-way-to-build-resilient-ai-applications-56b090ed3e69
3. **Tiered inference with confidence-based escalation.** Route decisions to the cheapest model that can handle them. Haiku classifies and escalates to Opus only on low confidence or high complexity. This pattern applies throughout (DM trigger, Scribe, content moderation, combat detection).
4. **The LLM never generates random numbers.** All dice rolls happen in deterministic code.
5. **Skill checks use pre-generated DC outcome tables.** Before rolling, Haiku generates a DC + three outcome descriptions (fail, success, great success). Roll, then inject the matched outcome into the next LLM call as a constraint — the LLM writes prose informed by the outcome, not prose pre-written for it.
6. **Emergent plot, not pre-planned arcs.** No pre-written plot graphs. The world has latent tensions; the Scribe tracks what players care about; the narrative develops those threads. Plot is discovered in retrospect.
7. **Prose quality is the product.** The Fast Thinker's output is the player's entire experience. Sensory detail, distinct NPC voices, tonal variety. No info-dumps.
8. **Specs are the source of truth.** If you're unsure about a behavior, read the spec. If the spec is silent, ask the user. Do not invent behavior that isn't specified.

## Code Conventions

- Named exports, no default exports (ESLint enforced)
- Strict TypeScript — no `any`, no type assertions unless unavoidable
- Functions < 50 lines, modules < 400 lines
- All Anthropic API calls through a single abstraction layer
- LLM prompts stored as template files, not inline strings
- All DB access through the repository layer
- UUIDv7 for all primary keys (time-ordered, good B-tree locality)
- Conventional Commits

## Agent Instructions

### Workflow

This project uses **Beads** for task tracking (or a similar issue tracker — TBD). The onboarding doc notes that Beads setup is part of initial project configuration.

Every implementation task follows this loop:
1. **Pick up work** from the tracker
2. **Understand before coding** — read the relevant spec deeply first
3. **TDD** — write a failing test that defines "done" before writing implementation code
4. **Implement** — minimum code to make the test pass
5. **Verify** — run the full relevant test suite + `pnpm typecheck` + `pnpm lint`
6. **Close the loop** — mark task done, commit with Conventional Commits

### Human-Agent Review Workflow

Work continuously through implementation batches without stopping for per-task review. Commit and push directly to `main` — no feature branches or PRs unless explicitly requested. The human reviews via `git log` and conversation.

**Stop and ask when:**
- A real design decision comes up that isn't covered by a spec
- Something fails and the right fix is ambiguous
- A task requires human action (adding API keys, clicking in AWS console, etc.)
- You're about to do anything destructive or hard to reverse

### Subagent Dispatch Rules

- **Use Opus for ALL subagents** unless the user explicitly requests otherwise
- **Never use worktree isolation** — worktrees silently destroy uncommitted work on cleanup
- **Assign non-overlapping files** to each agent. Verify before dispatching that no two agents will write to the same file.

### Standing Rules

- TDD: failing tests before implementation
- `pnpm typecheck` + `pnpm lint` + `pnpm test` before marking work done
- Never hardcode model names — use config constants
- Tier boundaries are hard. If you're tempted to pass plot info to the Fast Thinker, stop. That's a bug.
- Session Close Protocol: `git status` → `git add` → `git commit` → `git push`. Work is not done until pushed.

## The Prototype Repo

There is a working single-player prototype at `/Users/miklos/Desktop/Files/Personal/mythrun-v5/` that validated the core mechanics (dual-thinker, prep engine, enforced ignorance, skill checks, Scribe extraction). **It is reference-only.** The production codebase is a clean rewrite.

What ports from the prototype (see Backend Core spec, section 10 of Pipeline spec):
- LLM prompt templates (`.txt` files, validated through months of iteration)
- Zod schemas for LLM output validation
- Universal random table data (JSON)
- SRD reference data

What does NOT port:
- Any code — everything is rewritten against the new schema (worlds vs campaigns, async Postgres, multiplayer, etc.)

**Do not read the prototype codebase mid-session unless you have a specific question about a validated behavior.** The specs are complete; the prototype is a fallback reference.
