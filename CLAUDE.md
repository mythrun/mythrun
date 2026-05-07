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

## Foundational Values

**Quality over speed of work.** Miklos does not care about how much work a thing takes. He cares whether the result is correct, durable, and well-shaped. "It's faster to ship the hacky version" is not a valid argument by itself — the bar is whether the work is fit-for-purpose for what Mythrun is trying to be (a launching production application targeting 200-500 concurrent sessions, with operational longevity in mind).

There IS a tradeoff axis, but it's calibrated by what's at stake:

- **Core infrastructure, schema, security, billing/payments, anything that runs in production unattended → never hack.** Build it right, even if it adds a half-day or a day. Cheap shortcuts on these surfaces compound into expensive incidents and rework. Examples: provisioning patterns (a one-off bastion is fine for a one-off; a recurring operational need gets a proper task definition), schema migrations, auth flows, credit ledger, ECS / RDS / Secrets Manager wiring, CI/CD pipelines.
- **Documentation, internal tooling, dev ergonomics, prototype scratch work → match the investment to the audience.** A throwaway helper script doesn't need a design doc. A wiki page that exists once and is read occasionally doesn't get five rounds of review. Use judgment.

When in doubt, ask. The default lean is "build it right." If you're tempted to ship a hack on infrastructure to save half a day, stop and either (a) build it right, or (b) flag the gap and propose adding a precondition bead, never silently ship the hack and move on.

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

### Trackers

Two trackers serve different altitudes:

- **Linear** (`MYT-` prefix, workspace: Mythrun, project: Mythrun Production) — long-term shipping view. Milestones = scope-named shipping checkpoints with scope-derived dates. Issues = multi-day work units with due dates. Morning-glance tool: "what's due today." Launch target: 2026-06-01.
- **Beads** (`myth-` prefix, `.beads/` in repo, Dolt-backed, git-committed) — per-feature implementation tracking. Beads are hours-to-half-day tasks derived from an implementation plan. Survives compactions across sessions. Empty between features; populated when a Linear issue gets picked up.

Never duplicate content between them. Linear stays at the shipping-view altitude; beads stays at the implementation-detail altitude.

### Standard Implementation Workflow

Every Linear issue goes through the full Superpowers workflow — no shortcuts, even for small tickets:

1. **Pick up** a Linear issue for the current sprint.
2. **Brainstorm** via the `superpowers:brainstorming` skill. Explore intent, requirements, edge cases, tradeoffs. End when the approach is aligned with Miklos.
3. **Write the plan** via the `superpowers:writing-plans` skill. Plan lands at `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`.
4. **Move the plan into Beads.** Decompose the plan into concrete beads (one per step) with `bd create`. Wire blockers with `bd dep`. This is the atomic work list for implementation.
5. **Implement** via `superpowers:executing-plans` (review-checkpointed) or `superpowers:subagent-driven-development` (parallel subagents on independent beads). Close each bead as it's done (`bd close`).
6. **Verify** — run the relevant test suite + `pnpm typecheck` + `pnpm lint` before marking anything done. Apply the `superpowers:verification-before-completion` skill here.
7. **Close the loop** — when all beads are closed and the "done when" condition is met:
   1. Commit any remaining code with Conventional Commits. **Do not push yet.**
   2. Dispatch the wiki-update subagent with the prompt from `docs/wiki/AUTHORING.md` (parameterized with the Linear issue id). The subagent updates `docs/wiki/` and commits its own changes locally.
   3. **Now `git push`** — code commits + wiki commit land in a single push, so CI sees a consistent state. (Pushing code first and letting the wiki catch up later guarantees a transient red `wiki:check` run between the two pushes; we avoid that.)
   4. Flip the Linear issue to Done via `mcp__linear-server__save_issue`. A `PostToolUse` hook (`.claude/hooks/post-linear-close.sh`) emits a reminder to dispatch the wiki subagent — that hook is a **backstop** in case step 2 was skipped, not the primary trigger. If the wiki was already updated in step 2, the subagent will detect no drift and exit cleanly.

TDD is required for implementation code — write a failing test that defines "done" before the implementation. The `superpowers:test-driven-development` skill enforces this.

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
- Wiki is not optional. Every Linear issue that ships code or infra updates the wiki in the same session, via the hook-dispatched subagent. CI (`pnpm wiki:check`) gates merges on wiki freshness.
- **Never accept an unexplained failure.** When something doesn't work for a reason you don't understand, *finding the root cause is the task* — not a nice-to-have. Read docs, search issues, dispatch a research subagent, file a question. Only propose workarounds or concessions *after* you can name the cause. "It just doesn't work, let's ship the reduced version" is never the right call by itself; sometimes the reduced version is right, but only once you can explain what's actually happening.
- **Don't offer to "call it for the day" inside working hours.** Miklos's working window is roughly 9am–6pm local time. Check the current time before suggesting we stop; if we're inside the window, propose continuing with the next concrete step instead. Outside the window or near the edges, a wrap-up offer is fine.

## The Brand + Design Repo

Brand voice, palette, logomarks, and design decisions live in a separate sibling repo, not in this one: `../../Design/mythrun-design` (sibling of the `Code/` directory containing this repo). Read `brand/brief.md` before any work that touches user-visible naming, copy, error messages, marketing strings, or visual identity. The brand has a strict register — Ghibli-not-Marvel, Lucas Pope-terse, no hype words, no gamerspeak — and skipping the brief wastes round-trips on naming. The brief covers voice, allowed/forbidden moves, target communities, and what Mythrun is/isn't. `brand/decisions.md` records the why behind specific choices.

Don't update or overwrite the design repo from agent sessions. New brand decisions are the user's call.

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
