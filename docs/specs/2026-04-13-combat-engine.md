# Combat Engine Sub-Spec

> **Type**: Sub-spec (conforms to Production Architecture Overview)
> **Date**: 2026-04-13
> **Status**: Draft
> **Parent**: `2026-04-06-production-architecture-overview.md`
> **Depends on**: Multiplayer Session Runtime (session lifecycle, WebSocket, DM trigger), Backend Core (schema, stat_blocks table), World & Campaign Pipeline (world gen, NPC entities)
> **Scope**: Two-layer combat system: Layer 1 (debug shell) for launch validation, Layer 2 (full 5e rules engine) for mechanical combat. AI-generated voxel battle maps. NPC/monster tactical AI. Combat-to-narrative handoff. SRD data import. AI-generated stat blocks.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Layer 1: Debug Shell](#2-layer-1-debug-shell)
3. [Layer 2: Full 5e Rules Engine](#3-layer-2-full-5e-rules-engine)
4. [SRD Data and AI-Generated Content](#4-srd-data-and-ai-generated-content)
5. [Combat State Machine](#5-combat-state-machine)
6. [Rules Engine Architecture](#6-rules-engine-architecture)
7. [Action Resolution Pipeline](#7-action-resolution-pipeline)
8. [Active Effects System](#8-active-effects-system)
9. [AI Tactical Decision-Making](#9-ai-tactical-decision-making)
10. [AI-Generated Voxel Maps](#10-ai-generated-voxel-maps)
11. [Combat-to-Narrative Handoff](#11-combat-to-narrative-handoff)
12. [Frontend Combat UI](#12-frontend-combat-ui)
13. [Testing Strategy](#13-testing-strategy)
14. [Dependencies](#14-dependencies)
15. [IP and Legal Constraints](#15-ip-and-legal-constraints)
16. [Out of Scope](#16-out-of-scope)

---

## 1. Overview

The combat engine is the most complex sub-system in Mythrun. It is built in two layers that share the same interface, allowing incremental delivery.

### Two Layers

**Layer 1: Debug Shell** — Ships first. Validates the combat trigger/resolution integration without a rules engine. The AI describes what happens, a human (or the AI in auto mode) declares the outcome, and the system applies state changes. This proves the plumbing works: combat detection, mode transition, post-combat handoff.

**Layer 2: Full 5e Rules Engine** — Plugs in behind the same interface. Server-authoritative mechanical enforcement: initiative, movement, attacks, spells, conditions, death saves, the full combat loop. AI narrates and decides NPC tactics. Players interact via the voxel map UI.

### Interface Contract

Both layers implement:

```typescript
interface CombatSystem {
  startCombat(context: CombatInitContext): Promise<CombatState>
  submitAction(state: CombatState, action: CombatAction): Promise<ActionResult>
  getAvailableActions(state: CombatState, combatantId: string): AvailableActions
  endCombat(state: CombatState, outcome: CombatOutcome): Promise<CombatSummary>
  isInCombat(sessionState: SessionState): boolean
}
```

The SessionController calls this interface. It doesn't know or care which layer is behind it.

### What Changed From the Architecture Overview

The CombatState model has been expanded per the review panel's feedback (concentration, spell slots, conditions with durations/sources, action stack, temporary HP, class features). The AI-generated voxel maps are confirmed as the only map generation approach (no template fallback). The combat-to-narrative handoff via CombatSummary is fully specified.

---

## 2. Layer 1: Debug Shell

### Purpose

Validate the full combat lifecycle without building a rules engine. The debug shell is a **text-based resolution mode** where combat outcomes are determined by freeform input rather than mechanical dice rolls.

### How It Works

1. **Combat trigger**: The DM (AI) declares combat. The session controller detects a `combat_trigger` tool call from the FT and invokes `startCombat()`.

2. **Initiative**: The debug shell rolls initiative for all combatants using the dice engine (this is mechanical, not AI — it works the same in both layers).

3. **Combat mode**: The session enters combat mode. The chat panel remains active. The FT continues generating narrative prose for each round.

4. **Resolution**: Instead of a rules engine resolving individual actions, the DM narrates the round and the system prompts for outcomes:
   - **Auto mode** (default): The FT narrates the combat and calls a `resolve_combat_round` tool that describes what happened. The system extracts HP changes, conditions applied, and casualties from the structured tool output.
   - **Manual mode** (debug): A human types the outcome: "the PCs defeated the goblins, Arin took 12 damage, Kael is unconscious." A Haiku call (per ZFC) parses this into structured state changes.

5. **Post-combat**: The system applies state changes (HP, conditions) and generates a CombatSummary for the narrative handoff.

### Debug Shell Tool Calls

```typescript
// FT calls this to trigger combat
interface CombatTriggerTool {
  name: 'initiate_combat'
  input: {
    enemies: Array<{ name: string; description: string; count: number }>
    environment: string  // "tavern interior", "forest clearing", etc.
    surprise: 'none' | 'players_surprised' | 'enemies_surprised'
  }
}

// FT calls this to resolve each round (auto mode)
interface CombatResolveTool {
  name: 'resolve_combat_round'
  input: {
    narration: string  // prose description of what happened
    hp_changes: Array<{ combatant_name: string; damage: number; healing: number }>
    conditions_applied: Array<{ combatant_name: string; condition: string }>
    conditions_removed: Array<{ combatant_name: string; condition: string }>
    casualties: Array<{ combatant_name: string; fate: 'dead' | 'unconscious' | 'fled' }>
    combat_continues: boolean
  }
}
```

### What the Debug Shell Validates

- Combat trigger detection works
- Session mode transition (exploration → combat → exploration) works
- Combat state is stored in Redis correctly
- CombatSummary generation and narrative handoff work
- The frontend can display combat state changes
- Post-combat the session resumes normally

### What It Doesn't Validate

- Individual action resolution (attacks, spells, movement)
- Rules correctness (AC, damage calculations, condition effects)
- Turn-based play with player input
- Voxel map rendering
- The full action stack/reaction system

---

## 3. Layer 2: Full 5e Rules Engine

### Design Principles

1. **Pure functions**: Given a `CombatState` and a `CombatAction`, return a new `CombatState` and an `ActionResult`. No side effects. Fully testable.
2. **Server-authoritative**: The client is untrusted. All actions validated server-side. The client shows available actions based on what the server tells it.
3. **Modular**: Each rules concern (movement, attacks, spells, conditions, death saves) is an independent module. Add or fix one without touching others.
4. **Data-driven**: Monster stats, spell effects, weapon properties, and condition mechanics come from imported data tables, not hardcoded logic. Adding a new spell = adding a data row, not writing code.
5. **AI-narrated**: The engine produces mechanical results. The AI produces prose. They're separate concerns.

### Key Dependencies

| Dependency | Purpose | License |
|-----------|---------|---------|
| **5e-database** (npm/imported JSON) | SRD monster stat blocks, spell definitions, weapon properties, condition rules | MIT / CC-BY-4.0 |
| **rot.js** | Pathfinding (A*), field of view, line of sight, distance calculation | BSD |
| **Foundry dnd5e + midi-qol** (reference only) | Rules implementation reference for edge cases. Not a runtime dependency. | MIT |

---

## 4. SRD Data and AI-Generated Content

### SRD Import

A one-time migration script imports data from 5e-database into Postgres:

| SRD Data | Target Table | Count |
|----------|-------------|-------|
| Monsters | `srd_monsters` (new) | ~332 |
| Spells | `srd_spells` (new) | ~319 |
| Weapons | `srd_weapons` (new) | ~37 |
| Armor | `srd_armor` (new) | ~13 |
| Conditions | `srd_conditions` (new) | 14 |
| Classes (combat features) | `srd_class_features` (new) | ~100+ |

These are reference tables — read-only, shared across all campaigns. They are NOT world-specific or campaign-specific.

### New Schema: SRD Reference Tables

```sql
CREATE TABLE srd_monsters (
  id TEXT PRIMARY KEY,  -- SRD index key, e.g., "adult-red-dragon"
  name TEXT NOT NULL,
  size TEXT NOT NULL,
  type TEXT NOT NULL,  -- "beast", "undead", "aberration", etc.
  alignment TEXT,
  ac INTEGER NOT NULL,
  ac_type TEXT,  -- "natural armor", "plate", etc.
  hp INTEGER NOT NULL,
  hit_dice TEXT NOT NULL,
  speed JSONB NOT NULL,  -- { walk: 30, fly: 60, swim: 0 }
  str INTEGER NOT NULL, dex INTEGER NOT NULL, con INTEGER NOT NULL,
  int INTEGER NOT NULL, wis INTEGER NOT NULL, cha INTEGER NOT NULL,
  saving_throws JSONB,  -- { str: 10, con: 7, ... }
  skills JSONB,  -- { perception: 11, stealth: 7 }
  damage_resistances TEXT[],
  damage_immunities TEXT[],
  damage_vulnerabilities TEXT[],
  condition_immunities TEXT[],
  senses JSONB,  -- { darkvision: 120, passive_perception: 21 }
  languages TEXT[],
  cr TEXT NOT NULL,  -- "1/4", "1", "17"
  xp INTEGER NOT NULL,
  special_abilities JSONB,  -- [{ name, desc, usage? }]
  actions JSONB,  -- [{ name, desc, attack_bonus?, damage? }]
  legendary_actions JSONB,
  reactions JSONB,
  data JSONB NOT NULL  -- full raw SRD JSON for anything not in columns
);

CREATE TABLE srd_spells (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  level INTEGER NOT NULL,  -- 0 = cantrip
  school TEXT NOT NULL,
  casting_time TEXT NOT NULL,
  range TEXT NOT NULL,
  components TEXT NOT NULL,  -- "V, S, M (a pinch of sand)"
  duration TEXT NOT NULL,
  concentration BOOLEAN NOT NULL DEFAULT false,
  description TEXT NOT NULL,
  higher_levels TEXT,  -- upcasting effects
  damage JSONB,  -- { type, dice_at_levels: { "1": "1d10", "5": "2d10" } }
  area_of_effect JSONB,  -- { type: "sphere", size: 20 }
  save JSONB,  -- { ability: "dex", effect: "half_damage" }
  classes TEXT[] NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE srd_conditions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  mechanical_effects JSONB NOT NULL  -- structured: { grants_advantage_to_attackers: true, speed_zero: true, ... }
);
```

### AI-Generated Stat Blocks

For NPCs and custom creatures not in the SRD, the AI generates stat blocks during world gen or on-demand when combat starts.

**During world gen** (pipeline stage): The existing `character_integration` stage can be extended to generate basic stat blocks for combat-relevant NPCs. These are stored in the existing `stat_blocks` and `stat_block_actions` tables.

**On-demand** (combat initiation): When the FT triggers combat against NPCs that don't have stat blocks, a Haiku/Sonnet call generates a mechanically valid stat block based on the NPC's description, role, and CR estimate. This is validated against SRD conventions (ability scores in range, HP matches hit dice, AC is plausible for the creature type).

```typescript
interface GenerateStatBlockInput {
  name: string
  description: string  // from prose kernel
  role: string  // "tavern brawler", "court mage", etc.
  estimatedCr: string  // "1/2", "3", "8"
  combatStyle: string  // "melee brute", "spellcaster", "archer", etc.
}
```

The generated stat block uses the same schema as SRD monsters, so the rules engine treats all combatants identically regardless of whether they're SRD or AI-generated.

---

## 5. Combat State Machine

```
EXPLORATION ──(combat_trigger)──> INITIATIVE_ROLL
                                      │
                                      ▼
                              COMBAT_ACTIVE ◄──┐
                                 │              │
                           ┌─────┼─────┐        │
                           ▼     ▼     ▼        │
                        PC_TURN  NPC_  LAIR_     │
                           │    TURN  ACTION     │
                           │     │     │         │
                           └─────┴─────┘         │
                                 │               │
                          ROUND_END ─────────────┘
                                 │
                          (combat over?)
                                 │
                                 ▼
                          COMBAT_END ──> EXPLORATION
```

### States

| State | Description |
|-------|-------------|
| `exploration` | Normal narrative play. No combat state. |
| `initiative_roll` | Combat triggered. Initiative rolled for all combatants. Map generated. |
| `combat_active` | Turn loop running. One combatant is active at a time. |
| `pc_turn` | A player character's turn. Waiting for player input. |
| `npc_turn` | An NPC/monster's turn. AI decides and submits actions. |
| `reaction_window` | A reaction-eligible event occurred. Waiting for player reactions (10s timer). |
| `combat_end` | Combat resolved. CombatSummary generated. Transitioning back to exploration. |

---

## 6. Rules Engine Architecture

### Module Structure

```
combat/
  engine/
    index.ts          # CombatSystem interface implementation
    state.ts          # CombatState types and constructors
    initiative.ts     # Initiative rolling and ordering
    movement.ts       # Movement, opportunity attacks, difficult terrain
    attacks.ts        # Melee/ranged attack resolution
    spells.ts         # Spell casting, slots, concentration, AoE
    conditions.ts     # Condition application, duration tracking, effects
    death-saves.ts    # Death save tracking, stabilization
    actions.ts        # Action economy (action, bonus, reaction, movement)
    damage.ts         # Damage calculation, resistance/vulnerability/immunity
    cover.ts          # Cover calculation from map geometry
    effects.ts        # Active effects system (buffs, debuffs, auras)
    stack.ts          # Action stack for reactions and triggered effects
    validation.ts     # Action validation (is this legal?)
  ai/
    tactics.ts        # NPC/monster tactical decision-making
    stat-gen.ts       # AI-generated stat block pipeline
  maps/
    generator.ts      # AI-to-voxel map compilation
    pathfinding.ts    # Wrapper around rot.js A*
    fov.ts            # Line of sight / field of view
  srd/
    importer.ts       # One-time SRD data import script
    lookup.ts         # Query SRD tables for monsters, spells, conditions
  types.ts            # All combat type definitions
```

### Core Types (Expanded From Architecture Overview)

```typescript
interface CombatState {
  id: string
  sessionId: string
  round: number
  phase: CombatPhase
  activeIndex: number
  initiativeOrder: Combatant[]
  map: VoxelMap
  actionStack: ActionStack
  log: CombatLogEntry[]
  startedAt: string
}

interface Combatant {
  id: string
  name: string
  type: 'pc' | 'npc' | 'monster'
  userId?: string  // for PCs
  statBlockId?: string  // reference to srd_monsters or stat_blocks
  position: Position
  initiative: number
  hp: number
  maxHp: number
  temporaryHp: number
  ac: number
  speed: SpeedMap  // { walk: 30, fly: 0, swim: 0, climb: 0 }
  abilityScores: AbilityScores
  proficiencyBonus: number
  conditions: ActiveCondition[]
  actionsRemaining: ActionEconomy
  concentratingOn: ConcentrationState | null
  spellSlots: Record<number, { used: number; max: number }>
  features: CombatFeature[]
  resistances: DamageType[]
  vulnerabilities: DamageType[]
  immunities: DamageType[]
  conditionImmunities: ConditionType[]
  deathSaves: { successes: number; failures: number } | null  // null if not dying
  isAlive: boolean
  isConscious: boolean
}

interface ActiveCondition {
  condition: ConditionType
  source: string  // combatant ID or spell/effect ID
  duration: ConditionDuration
  mechanicalEffects: ConditionEffects  // loaded from srd_conditions
}

interface ConditionDuration {
  type: 'turns' | 'rounds' | 'concentration' | 'save' | 'permanent' | 'special'
  remaining?: number
  saveAbility?: AbilityKey
  saveDc?: number
  endsOnSave?: 'start_of_turn' | 'end_of_turn'
}

interface ConditionEffects {
  grantsAdvantageToAttackers?: boolean
  grantsDisadvantageOnAttacks?: boolean
  grantsDisadvantageOnAbilityChecks?: boolean
  grantsDisadvantageOnSavingThrows?: AbilityKey[]
  autoFailSavingThrows?: AbilityKey[]
  speedZero?: boolean
  speedHalved?: boolean
  cantTakeActions?: boolean
  cantTakeReactions?: boolean
  cantSpeak?: boolean
  prone?: boolean  // melee advantage within 5ft, ranged disadvantage
  // ... extensible for all 14 SRD conditions
}

interface ActionEconomy {
  action: boolean
  bonusAction: boolean
  reaction: boolean
  movement: number  // feet remaining
  freeObjectInteraction: boolean
}

interface ConcentrationState {
  spellId: string
  spellName: string
  targetIds: string[]
  effectIds: string[]  // active effects to remove if concentration breaks
}

interface CombatFeature {
  id: string
  name: string
  source: string
  usesRemaining: number
  usesMax: number
  resetsOn: 'short_rest' | 'long_rest' | 'turn' | 'round'
}

interface ActionStack {
  entries: StackEntry[]
}

interface StackEntry {
  id: string
  action: CombatAction
  source: string  // combatant ID
  triggeredBy?: string  // stack entry ID
  status: 'pending' | 'resolving' | 'resolved'
}

type Position = { x: number; y: number; z: number }
type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
type DamageType = 'slashing' | 'piercing' | 'bludgeoning' | 'fire' | 'cold' | 'lightning' | 'thunder' | 'poison' | 'acid' | 'necrotic' | 'radiant' | 'force' | 'psychic'
type ConditionType = 'blinded' | 'charmed' | 'deafened' | 'frightened' | 'grappled' | 'incapacitated' | 'invisible' | 'paralyzed' | 'petrified' | 'poisoned' | 'prone' | 'restrained' | 'stunned' | 'unconscious' | 'exhaustion'
```

---

## 7. Action Resolution Pipeline

### The Pipeline

Every combat action flows through a pipeline modeled on midi-qol's workflow:

```
1. SUBMIT ACTION
   ├── Validate: is it this combatant's turn? Do they have the action/bonus/reaction?
   ├── Validate: is the target valid? In range? Line of sight?
   └── Validate: does the combatant have the resources? (spell slots, feature uses)

2. CHECK FOR REACTIONS
   ├── Does this action trigger any reactions? (opportunity attacks, Shield, Counterspell)
   ├── If yes: push reactions onto the action stack
   ├── Open reaction window for eligible players (10s timer)
   └── NPC reactions decided by AI immediately

3. RESOLVE STACK (top-down)
   ├── Resolve topmost stack entry
   │   ├── Roll dice (attacks, saves, damage)
   │   ├── Apply effects
   │   └── Check for cascading reactions (Counterspell countering Counterspell)
   └── Repeat until stack is empty

4. APPLY RESULTS
   ├── Update HP (damage, healing, temporary HP)
   ├── Apply/remove conditions
   ├── Check concentration (CON save on damage)
   ├── Check death (HP ≤ 0 → death saves or instant death)
   ├── Consume resources (spell slots, feature uses, movement)
   └── Update action economy

5. GENERATE EVENTS
   ├── CombatEvent[] for AI narration
   ├── combat_update WebSocket message for clients
   └── CombatLogEntry for the combat log

6. CHECK END CONDITIONS
   ├── All enemies dead/fled/surrendered?
   ├── All PCs dead/unconscious?
   └── If combat over: transition to COMBAT_END
```

### Reaction Window

When a reaction-eligible event occurs:

1. Server identifies combatants with unused reactions and relevant reaction abilities
2. Server broadcasts `reaction_window` with a 10-second timer and the list of eligible combatants
3. Players with valid reactions see a prompt in the UI
4. If a player reacts: their reaction goes on the stack
5. If timer expires with no reactions: stack resolves without them
6. NPCs decide immediately (AI call, no timer)

**Concurrency note:** All combat state mutations (pushing reactions onto the stack, resolving actions) use a Redis Lua script for atomic read-modify-write. This prevents a lost-update race condition when two players submit reactions simultaneously from different containers.

### Movement and Opportunity Attacks

Movement is validated step by step:
- Each 5-foot step is checked for: remaining movement, difficult terrain cost, obstacles
- If a combatant moves out of an enemy's reach: opportunity attack triggers (goes on stack)
- Disengage action prevents opportunity attacks
- Movement can be split around actions (move 15ft, attack, move 15ft)

Pathfinding uses rot.js A* to compute valid paths and movement cost. The client shows path preview with cost before the player commits.

---

## 8. Active Effects System

### Design (Informed by Foundry's DAE)

Effects are data-driven modifications to combatant attributes:

```typescript
interface ActiveEffect {
  id: string
  name: string  // "Bless", "Rage", "Shield of Faith"
  source: string  // combatant ID, spell ID, or item ID
  duration: ConditionDuration
  changes: AttributeChange[]
  flags: EffectFlags
}

interface AttributeChange {
  attribute: string  // "ac", "speed.walk", "damage.bonus", etc.
  mode: 'add' | 'multiply' | 'override' | 'advantage' | 'disadvantage'
  value: number | string
}

interface EffectFlags {
  requiresConcentration?: boolean
  endOnDamage?: boolean  // some effects end when the target takes damage
  endOnSave?: { ability: AbilityKey; dc: number; timing: 'start_of_turn' | 'end_of_turn' }
  aura?: { radius: number; affects: 'allies' | 'enemies' | 'all' }  // aura effects reapply based on position
}
```

### Effect Resolution Order

When calculating a combatant's effective stats:
1. Start with base values (from stat block / character sheet)
2. Apply `add` changes (sum all bonuses)
3. Apply `multiply` changes (product of all multipliers)
4. Apply `override` changes (highest override wins)
5. Determine advantage/disadvantage (any source of advantage + any source of disadvantage = straight roll, per 5e rules)

### Effect Lifecycle

- **Apply**: When a spell is cast, feature is activated, or condition is imposed
- **Tick**: At the start or end of each round/turn (depending on duration type), decrement remaining duration. Allow saves if applicable.
- **Expire**: When duration reaches 0, concentration is broken, or a save succeeds. Remove all attribute changes.
- **Concentration break**: When the concentrating combatant takes damage, they make a CON save (DC = max(10, damage/2)). On failure, all effects from that concentration source are removed.

---

## 9. AI Tactical Decision-Making

### NPC Turn Processing

When it's an NPC/monster's turn:

1. Build context for the AI: current combat state, the NPC's available actions, nearby combatants and their status, map terrain
2. The AI receives **limited information** (per ZFC + game balance):

| Info Available to AI | Info Hidden From AI |
|---------------------|-------------------|
| Combatant positions | Exact PC hit points (sees "uninjured/bloodied/critical") |
| Who is visually concentrating (somatic components) | PC spell slots remaining |
| Visible conditions (prone, grappled, etc.) | PC class features remaining |
| Own stat block and abilities | PC AC (until an attack hits/misses) |
| Previous round's events | PC saving throw bonuses |

3. AI decides via structured tool call:

```typescript
interface NpcTacticalDecision {
  combatantId: string
  actions: Array<{
    type: 'move' | 'attack' | 'cast_spell' | 'use_ability' | 'dodge' | 'dash' | 'disengage' | 'hide'
    target?: string  // combatant ID
    position?: Position  // for movement
    abilityId?: string  // for spells/abilities
    reasoning: string  // for debugging/narration, not shown to players
  }>
}
```

### Tactical Personality

Each monster/NPC has a tactical profile based on Intelligence and type:

| INT Range | Tactical Style |
|-----------|---------------|
| 1-3 | Mindless — attacks nearest, no self-preservation |
| 4-6 | Instinctive — attacks whoever hit it last, flees at low HP |
| 7-10 | Basic tactical — focuses weakened targets, uses terrain |
| 11-14 | Tactical — coordinates with allies, targets casters, uses abilities strategically |
| 15+ | Strategic — exploits conditions, manages action economy, feints and repositions |

The AI receives this tactical profile as part of its context. The profile is a **guide**, not a constraint — the AI has creative freedom within the style.

### Hard Rules for AI Combat

- Never attack an unconscious character unless specifically cruel (monster type: fiend, undead) AND no other targets exist
- Never make tactically optimal plays that require knowledge the NPC shouldn't have (don't target the Wizard's low CON save unless the NPC has observed the Wizard failing a CON save)
- Periodically make suboptimal but flavorful choices (the orc war chief taunts instead of attacking, the wolf pack tries to surround before engaging)

---

## 10. AI-Generated Voxel Maps

### Map Generation Pipeline

When combat is triggered:

1. **AI describes the battlefield** via the `describe_battlefield` tool call:

```typescript
interface BattlefieldDescription {
  dimensions: { width: number; height: number }  // in 5ft squares
  elevation_range: { min: number; max: number }  // in 5ft increments
  terrain_type: string  // "dungeon", "forest", "tavern", "cave", etc.
  features: Array<{
    type: string  // "wall", "pillar", "table", "tree", "boulder", "pit", "stairs", etc.
    position: { x: number; y: number }
    size: { width: number; height: number }
    elevation?: number
    properties?: string[]  // "difficult_terrain", "half_cover", "full_cover", "climbable"
  }>
  entrances: Array<{ position: { x: number; y: number }; direction: string }>
  lighting: string  // "bright", "dim", "darkness"
  environmental_hazards: Array<{ type: string; area: { x: number; y: number; radius: number } }>
  enemy_positions: Array<{ name: string; position: { x: number; y: number } }>
  player_entry: { x: number; y: number }
}
```

2. **Map compiler** (deterministic code, not AI) translates the description into a `VoxelMap`:
   - Each feature type maps to voxel geometry from a primitive library
   - Floor plane is generated based on dimensions
   - Walls are placed at map boundaries and per feature list
   - Features are composited onto the floor plane
   - If a feature doesn't compile (unknown type, overlapping geometry): log a warning, skip the feature (the map is degraded but functional)

3. **Token placement**: PCs at the `player_entry` position, enemies at their specified positions

### Voxel Primitive Library

The compiler knows a fixed set of primitive types. Each maps to a voxel geometry generator:

| Primitive | Voxel Output | Grid Squares |
|-----------|-------------|-------------|
| `wall` | Solid voxel column, full height | 1xN or Nx1 |
| `pillar` | Solid 1x1 column | 1x1 |
| `table` | Half-height solid block | 2x1 or 1x2 |
| `stairs` | Ramped voxels, 1 square wide | 1xN |
| `tree` | Trunk (1x1 column) + canopy (3x3 at height) | 1x1 base |
| `boulder` | Rounded solid block | 1x1 or 2x2 |
| `pit` | Empty space below floor level | NxM |
| `door` | Thin voxel plane in a wall gap | 1x1 |
| `water` | Floor-level translucent voxels | NxM |
| `elevation` | Raised or lowered floor plane | NxM |

The AI's structured output is constrained to these known types. Unknown feature types are logged and skipped.

### R&D Flag

The map compiler is the most uncertain component. It needs a dedicated prototype/spike to validate:
- Can the AI reliably produce valid `BattlefieldDescription` JSON?
- Does the primitive library produce visually coherent maps?
- What's the failure rate, and is it acceptable? (Our standard: AI maps must work. Failures are bugs, not features.)

Prior art: MineBench demonstrates LLM capability for structured voxel generation at higher complexity than what we require (room-scale environments vs open-world terrain).

---

## 11. Combat-to-Narrative Handoff

When combat ends, the rules engine produces a `CombatSummary`:

```typescript
interface CombatSummary {
  outcome: 'victory' | 'defeat' | 'flee' | 'surrender' | 'other'
  outcomeDescription: string  // brief prose summary
  roundsElapsed: number
  casualties: Array<{
    name: string
    type: 'pc' | 'npc' | 'monster'
    fate: 'dead' | 'unconscious' | 'fled' | 'surrendered' | 'captured'
  }>
  dramaticMoments: Array<{
    description: string
    combatantId: string
    type: 'critical_hit' | 'critical_miss' | 'death_save_success' | 'last_stand' | 'first_blood' | 'killing_blow' | 'spell_impact'
  }>
  resourcesExpended: Array<{
    combatantId: string
    resource: string  // "spell_slot_3", "action_surge", "rage"
    amount: number
  }>
  hpChanges: Array<{
    combatantId: string
    hpBefore: number
    hpAfter: number
    maxHp: number
  }>
  conditionsRemaining: Array<{
    combatantId: string
    condition: string
    remainingDuration: string
  }>
  loot: Array<{
    source: string  // dead enemy name
    items: string[]  // described by AI, not mechanically generated
  }>
}
```

### Where the Summary Goes

1. **Broadcast** to all clients as the `combat_summary` field in `combat_end` message
2. **Slow Thinker** receives it as context for post-combat narrative direction ("Arin nearly died — have an NPC react to that")
3. **Fast Thinker** receives a prose version for narrative continuity ("After a fierce battle where Arin barely survived and Kael landed the killing blow...")
4. **Scribe** extracts facts: NPC deaths become resolved facts, PC injuries become delivered facts, loot becomes equipment
5. **Character state** updated: HP, spell slots, feature uses persisted to Postgres

---

## 12. Frontend Combat UI

### Layout (From Architecture Overview)

When combat starts:
1. Brief "Roll initiative" transition (~1-2 seconds)
2. Screen reorganizes into combat layout:
   - **Center**: Voxel map (Three.js via react-three-fiber)
   - **Right side**: Chat narration panel (reduced — DM narrates combat actions)
   - **Top**: Initiative tracker (horizontal bar showing turn order with HP bars)
   - **Bottom**: Action palette (available actions for the active PC)

### Voxel Map Renderer

- **react-three-fiber** for React integration with Three.js
- Isometric camera (fixed angle, zoomable, pannable)
- Low-detail voxel aesthetic (Minecraft-esque but more stylized — Townscaper/Monument Valley reference from UX spec)
- Token rendering: simple voxel character models (colored cubes with minimal detail for MVP, procedural voxel portraits later)
- Terrain rendering: floor, walls, obstacles from VoxelMap data
- Interaction: click-to-move (path preview with cost), click-to-target (range indicator, hit probability)

### Action Palette

Shows available actions based on `getAvailableActions()` response from the server:
- **Action**: Attack, Cast Spell, Dodge, Dash, Disengage, Help, Hide, Use Item, Use Feature
- **Bonus Action**: applicable bonus action features/spells
- **Movement**: remaining feet displayed, click map to move
- Grayed-out actions show why they're unavailable ("No spell slots remaining", "Already used your action")

### Initiative Tracker

Horizontal bar at top:
- Portrait/icon for each combatant
- HP bar (green/yellow/red)
- Active turn highlighted
- Condition icons on combatant portraits

### Context Bridge (From UX Spec)

The combat chat begins with the last 3-5 DM messages from the main chat (visually dimmed, separated by a divider). This gives context about how the players got into this fight.

---

## 13. Testing Strategy

### Unit Tests (Pure Functions)

Every rules module gets exhaustive unit tests:

| Module | Test Categories |
|--------|----------------|
| `attacks.ts` | Melee/ranged, advantage/disadvantage, critical hits, damage types, resistance/vulnerability |
| `spells.ts` | Slot consumption, concentration, AoE targeting, upcasting, save effects |
| `conditions.ts` | Each of 14 conditions: application, effects, duration tracking, removal |
| `movement.ts` | Speed limits, difficult terrain, opportunity attacks, flying, swimming, climbing |
| `death-saves.ts` | Success/failure tracking, stabilization, healing from 0, instant death, death save crits |
| `damage.ts` | Resistance halves, vulnerability doubles, immunity blocks, temp HP absorbed first |
| `stack.ts` | Reaction ordering, Counterspell chains, nested triggers |

### Integration Tests

- Full combat encounter: 2 PCs vs 3 goblins, run to completion, verify final state
- Edge case encounters: concentration + damage, grapple + movement, readied action triggers
- AI tactical tests: verify AI makes reasonable decisions for different INT levels

### Statistical Validation

Run 1,000+ simulated combats for common encounters (CR-appropriate). Compare average rounds-to-completion and casualty rates against community-published encounter balance data. Large deviations indicate rules bugs.

### SRD Validation Suite

Automated checks on imported SRD data:
- Every monster has valid ability scores, AC, HP matching hit dice
- Every spell has required fields (range, duration, components)
- Cross-references are valid (spell mentions a condition that exists, monster references an action that's defined)

---

## 14. Dependencies

### Runtime Dependencies

| Package | Purpose |
|---------|---------|
| `rot.js` | Pathfinding (A*), FOV, line of sight |
| `react-three-fiber` | React + Three.js for voxel map rendering |
| `@react-three/drei` | Three.js helpers (camera controls, loaders) |
| `three` | 3D rendering engine (peer dep of react-three-fiber) |

### Data Dependencies

| Source | Purpose |
|--------|---------|
| `5e-database` (5e-bits) | SRD monster/spell/condition/weapon/armor data |

### Reference Only (Not Runtime)

| Source | Purpose |
|--------|---------|
| Foundry dnd5e | Rules implementation reference |
| midi-qol | Combat automation workflow reference |
| DAE | Active effects system design reference |

---

## 15. IP and Legal Constraints

### What We Ship

- **SRD content (CC-BY-4.0)**: ~332 monsters, ~319 spells, all base classes, races, equipment, conditions. Free to use commercially with attribution.
- **AI-generated homebrew**: Original stat blocks, creatures, and abilities generated by the AI. Mechanically compatible with 5e, not copies of published content.
- **Game mechanics**: 5e rules themselves are not copyrightable. We can implement any rule.

### What We Don't Ship

- Non-SRD published content (Monster Manual, DMG, Xanathar's, Tasha's, etc.)
- Trademarked creature names: Beholder, Mind Flayer, Displacer Beast, etc.
- Published adventure content, lore, or artwork

### Content Filter

The AI (both world gen and combat) is instructed to use SRD creature names and generate original content for anything else. A Haiku-based content filter (per ZFC) scans generated content for known trademarked terms and flags/replaces them:
- "Beholder" → "Gazing Aberration" or similar AI-generated alternative
- "Mind Flayer" → "Psionic Devourer" or similar

### Legal Action Item

**Before launch**: Consult an IP attorney specializing in tabletop gaming to review:
- Our use of SRD content under CC-BY-4.0
- Our approach to AI-generated content that may resemble copyrighted material
- Whether any mechanical implementations cross the line from "uncopyrightable game rules" to "copyrighted creative expression"
- Options for licensing non-SRD content from WotC/Hasbro in the future

---

## 16. Out of Scope

| Feature | Notes |
|---------|-------|
| Mounted combat | Future rules module |
| Underwater combat | Future rules module |
| Vehicle combat | Future rules module |
| Mass combat (armies) | Future — different system entirely |
| Lair actions | Supported in data model (srd_monsters.legendary_actions includes lair), but not in Layer 2 at launch |
| Multiclassing combat features | Future — single-class characters at launch |
| Homebrew rules toggles (variant: flanking, encumbrance, etc.) | Future — settings per campaign |
| VTT-style fog of war | Future — rot.js FOV supports it, but the UI work is substantial |
| Animated combat tokens (voxel character models) | Future — colored cubes for MVP |
| Sound effects / combat music | Future |
| Combat replay / review | Future |
