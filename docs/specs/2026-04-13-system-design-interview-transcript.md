# System Design Interview Transcript — Mythrun Architecture

> **Date**: 2026-04-13
> **Format**: Mock system design interview to evaluate the Mythrun production architecture
> **Interviewers**: Dr. Vivian Zhao (Principal Engineer, Infrastructure), Marcus Chen (Principal Engineer, Game Systems)
> **Candidate**: Jimmy (presenting the Mythrun architecture as his design)

---

VIVIAN: All right, Jimmy. Thanks for coming in. I'm Vivian, and this is Marcus. We're going to spend about 45 minutes on a system design problem. We've sent you the prompt ahead of time -- multiplayer AI D&D platform, 500 concurrent sessions, LLM-powered DM, real-time chat, tactical combat, session-pack billing. Marcus and I are going to ask you to walk us through your design and then dig into specific areas. Take a few minutes to walk us through the big picture.

JIMMY: Sure, thanks. Let me start at the top.

The system has three main compute components. First is the API service -- Node.js with Fastify running on ECS Fargate behind an Application Load Balancer. This handles all REST endpoints and WebSocket connections. It's stateless -- all session state lives in Redis, all persistent data in Postgres. I can run multiple instances behind the ALB with no sticky sessions.

Second is a separate Worker service, also on ECS Fargate, same Docker image but a different entrypoint. This runs BullMQ workers for the long-running pipeline jobs -- world generation, character creation, the prep engine stages. The reason it's separate is that these pipeline calls hit the Opus model and can take 30-60 seconds each. If those are competing for CPU and memory with WebSocket connections and live player requests, you get degraded session performance. The separation is a bulkhead pattern.

Third is the data layer. Postgres on RDS for all durable state -- users, worlds, campaigns, entities, facts, sessions, billing. Redis on ElastiCache for real-time coordination -- session state, pub/sub for cross-container WebSocket messaging, distributed locks, BullMQ job queues, rate limiting counters, and message sequence numbers.

For the network -- everything runs in a single VPC in us-east-1. Public subnets for the ALB and NAT Gateway, private subnets for ECS tasks, RDS, and Redis. All outbound traffic to Anthropic and Stripe goes through the NAT Gateway. Frontend is static assets on S3 behind CloudFront. Auth is AWS Cognito handling Google and Discord OAuth.

MARCUS: Good. Before we dive in -- walk me through the data model. What's the relationship between worlds and campaigns?

JIMMY: This is a key architectural decision. Worlds and campaigns are separate entities. A World is a reusable template -- it contains the setting content: NPCs, locations, factions, prose kernels, facts, relationships, random tables. A Campaign is a personalized fork of a world for a specific party.

The pipeline flow works like this: first, the World Gen Pipeline creates a world through five stages -- concept intake, world and factions, locations and NPCs, starting situations, random tables. Then the Campaign Setup Pipeline forks that world. If it's from a shared source, we deep-copy all entities with new UUIDs, create the campaign pointing at the forked world, run per-player character creation, and then campaign-wide stages like relationship materialization and continuity checks.

As play progresses, the Scribe -- that's the post-turn extraction system -- mutates the campaign's forked world. The original template stays pristine. This enables a future marketplace where creators share worlds and earn payouts when others fork them. We track attribution through a `source_world_id` column and a `fork_count` counter.

VIVIAN: I like the template-fork model. Let's talk about the fork operation itself. You said deep-copy all entities with new UUIDs. How many entities are we talking about in a typical world?

JIMMY: A well-built world has maybe 20-40 NPCs, 10-20 locations, 3-6 factions, a few hundred facts, associated relationships and prose kernels. So we're looking at maybe 500-800 rows being copied across six or seven tables. In a single Postgres transaction that's sub-second even on a micro instance.

VIVIAN: And the fork_count increment -- is that in the same transaction as the deep copy?

JIMMY: Good question. No, it shouldn't be. The fork count on the source world is a separate UPDATE. If we include it in the same transaction as the deep copy, we're holding a lock on the source world row for the entire duration of the copy. For a popular world getting forked frequently, that becomes a contention point. The fork count is an approximate metric for marketplace ranking -- it's fine to increment it in a separate, fast transaction. Worst case, a crash between the two operations means the count is off by one, which is acceptable for a display metric.

VIVIAN: Good instinct. What if a popular world gets 1,000 forks in one hour? But we'll come back to that in the curveball section. Let's go to real-time multiplayer. Marcus?

MARCUS: Yeah, let's dig into the WebSocket architecture. Walk me through what happens when Player A on Container 1 sends a message that Player B on Container 2 needs to see.

JIMMY: Sure. Player A sends a `player_message` over their WebSocket to Container 1. Container 1 does a few things: assigns a server-side monotonic sequence number via `REDIS INCR` on a per-session counter, attaches the user ID and display name, then publishes the complete message to a Redis pub/sub channel -- `session:{campaignId}`. Container 2 is subscribed to that channel because it has Player B connected. It receives the message from Redis pub/sub and pushes it down Player B's WebSocket.

MARCUS: So every container subscribes to every active session's channel?

JIMMY: No -- each container only subscribes to channels for sessions where it has at least one connected client. When the last client for a session disconnects from a container, that container unsubscribes from the channel. This keeps the subscription fan-out proportional to the actual distribution of connections, not the total session count.

MARCUS: Good. Now, the sequence number -- you said Redis INCR. What ordering guarantees does that give you?

JIMMY: It gives me a total order. Redis INCR is atomic and single-threaded -- two concurrent INCRs on the same key will always produce two different, monotonically increasing values. So even if Player A and Player B send messages at the same instant to different containers, each will get a unique sequence number. Clients render messages in sequence order, not arrival order.

MARCUS: What happens if the sequence numbers arrive out of order at the client? Say seq 5 arrives before seq 4 because of network jitter.

JIMMY: The client maintains a buffer. If it receives seq 5 and its last seen is 3, it holds seq 5 and waits briefly for seq 4. If seq 4 arrives within a short window -- say 200ms -- it renders both in order. If the gap persists, it requests the missing messages from the server. The server can satisfy that via `SELECT * FROM session_messages WHERE session_id = $1 AND seq > $lastSeen ORDER BY seq`, since all messages are also persisted to the session_messages table.

MARCUS: When are they persisted? Synchronously on every message?

JIMMY: Yes, every message gets an INSERT into session_messages. It's append-only -- no updates, no rewrites. The old design used a JSON blob transcript that was rewritten every 5 minutes, which doesn't scale. The new design is just an INSERT with a composite index on (session_id, seq). That's microseconds for Postgres.

VIVIAN: And that's your source of truth for reconnection?

JIMMY: Right. On reconnect, the client sends its last-seen sequence number. The server replays from the session_messages table -- `WHERE session_id = $1 AND seq > $lastSeen ORDER BY seq`. For the latest state -- who's connected, current session mode, whether combat is active -- that's loaded from Redis. Redis is the hot state; Postgres is the durable record.

VIVIAN: Let me push on the Redis dependency. You said Redis is critical, not degradable. What does that mean for your availability story?

JIMMY: It means if Redis goes down, active sessions are disrupted. There's no graceful degradation path for session state reads, pub/sub, or distributed locks when Redis is unavailable. The mitigation is ElastiCache Multi-AZ with automatic failover -- typical failover time is 10-30 seconds. During that window, players get disconnected. On reconnect, the new Redis primary has the replicated state.

VIVIAN: But you said you're launching with a single Redis node, no replica.

JIMMY: That's right. At launch, a single-node failure means ElastiCache restarts the node -- that's about 30 seconds of disruption. Adding a replica for Multi-AZ failover costs about $12-24 a month. The plan is to add it when revenue justifies the cost, but I want to be honest -- this is a calculated risk. At 50-200 concurrent sessions, which is our realistic launch target, a 30-second outage is annoying but not business-killing.

VIVIAN: What happens to the session state during those 30 seconds? Redis restarted means the data is gone.

JIMMY: That's where the checkpoint strategy comes in. Session state is checkpointed to Postgres every 5 minutes -- transcript, running summary, token usage. So the worst case is losing the last 5 minutes of conversation. On reconnect, the server loads the last checkpoint from Postgres, and the session continues from there. Players might see a message like "Session recovered -- some recent messages may have been lost." It's not ideal, but it preserves the session.

MARCUS: Now let's talk about the DM trigger system. In a multiplayer game, how does the AI DM decide when to respond?

JIMMY: Hybrid system. There are two trigger modes. First is explicit: any message containing @DM or a dedicated dm_invoke message type always triggers the DM. Second is auto-trigger: a lightweight classifier -- I'm thinking Haiku-class model, very fast, very cheap -- evaluates recent messages after a debounce window of 2-3 seconds of silence. The classifier decides whether a DM response is warranted. It fires when a player describes an action that needs resolution, when an NPC is addressed directly, when there's been silence for too long after the DM's last response, or when a combat trigger is detected.

MARCUS: Why the debounce? Why not evaluate after every message?

JIMMY: In a multiplayer chat, players often send multiple messages in quick succession -- someone types "I walk up to the door" then "and try to listen for sounds on the other side." If the DM responds after the first message, it misses the full intent. The debounce window collects the burst and evaluates the full context. It also saves money -- we're not paying for a Haiku call on every single chat line.

MARCUS: What if a new message arrives while the classifier is in-flight?

JIMMY: The classifier call is cancelled and restarted with the fuller context. The debounce timer resets on every new message.

MARCUS: OK, and what about the dual-thinker model? Walk me through a DM response.

JIMMY: When a trigger fires -- explicit or auto -- the flow is: first, acquire a distributed lock on `session:{campaignId}:lock` in Redis so only one container can generate a DM response at a time. Then send `dm_thinking` to all clients so they see a typing indicator. Next, run the Slow Thinker -- that's the Opus model acting as narrative director. It sees everything: the full playbook with NPC secrets, faction motivations, hidden plot threads. It evaluates whether to intervene and if so, produces a stage direction.

Then the Fast Thinker -- Sonnet model -- generates the actual player-facing prose. Critically, the Fast Thinker operates under enforced ignorance. It never sees secret facts, NPC hidden motivations, or plot information. It receives only public facts, the player's messages, and the Slow Thinker's stage direction. The direction is behavioral, not informational -- "the merchant becomes nervous and evasive," not "the merchant is secretly the assassin."

The Fast Thinker's response streams to all clients. Then the Scribe fires asynchronously to extract any world state changes -- new facts, entity modifications, relationship changes. Finally, turn_end is sent and the lock is released.

VIVIAN: You said the lock has a 120-second base TTL with heartbeat renewal every 15 seconds. Why not just a long static TTL?

JIMMY: Because a crashed holder with a long static TTL blocks all DM responses for the entire TTL duration. With heartbeat extension, the base TTL is still 120 seconds -- long enough for any single Opus call -- but the holder actively renews it every 15 seconds. If the holder crashes, the lock expires in at most 120 seconds. Without heartbeat, you'd either set a short TTL and risk expiry during legitimate long calls, or a long TTL and risk blocking on crashes. The heartbeat gives you both safety properties.

MARCUS: What's the fencing token for?

JIMMY: Good catch. The Redlock pattern with fencing tokens prevents a stale holder from writing results. Imagine Container A acquires the lock, starts generating a DM response, then gets slow-killed or network-partitioned. The lock expires. Container B acquires the lock with a new fencing token and starts its own response. If Container A comes back to life and tries to publish its response, the fencing token comparison rejects it because the current token is higher than the one A held. Without fencing, you could get duplicate DM responses.

VIVIAN: Let's move to the data model and scaling. The session_messages table -- you said it's append-only with an index on (session_id, seq). How many rows per session?

JIMMY: A typical 3-hour session with 4 players might generate 200-400 messages total -- player messages, DM responses, skill check results, system messages. At 500 concurrent sessions, that's maybe 150,000-200,000 new rows per hour during peak. Per day, maybe a million rows on a busy day. Over a year, 100-300 million rows in that table.

VIVIAN: And you're running all of this on a db.t4g.micro with 1GB of RAM?

JIMMY: At launch, yes. The session_messages INSERT is trivially cheap -- it's an append into an indexed B-tree with UUIDv7 keys, which are time-ordered and naturally append-only. No page splits, good cache locality. The reads are all point queries on the composite index. At 300 million rows, the index might be a few GB, which exceeds the micro's buffer pool. That's when we upgrade to a t4g.small -- double the RAM for an extra $13 a month. The progression table is defined: micro at launch, small when CPU or buffer pool pressure appears, then medium if needed. It's a Terraform parameter change, not a redesign.

VIVIAN: What about the credit_ledger table? You're using SUM with an expiry filter for balance checks. That's a table scan per balance lookup.

JIMMY: Not a full table scan -- there's an index on (user_id, expires_at). So it's an index scan scoped to one user's ledger entries. A typical user might have 20-50 ledger entries over their lifetime -- purchases, debits, maybe a trial, maybe a gift. The SUM over 50 rows via an indexed scan is microseconds.

VIVIAN: And you're doing this check at session start?

JIMMY: Yes, and it's the only time we check the full balance. During the session, we've already debited a credit at start. Token usage tracking is a separate concern -- that's accumulated in Redis during the session and persisted to session_usage at session end.

VIVIAN: Tell me about the debit operation. What prevents double-spend in a race condition where two browsers try to start a session simultaneously?

JIMMY: The balance check and debit need to be atomic. The approach is a serializable transaction or an advisory lock. Check balance, insert the negative-amount debit row, and verify the new balance is non-negative -- all in one transaction. If the balance would go negative, the transaction rolls back. The UNIQUE constraint on (session_id) in session_usage also prevents duplicate session creation from the same request.

VIVIAN: That's correct. Advisory lock is probably more practical at your scale than SERIALIZABLE isolation, but either works. Let's talk about the LLM integration in more depth. Marcus?

MARCUS: Yeah. The dual-thinker model -- Opus for the Slow Thinker, Sonnet for the Fast Thinker. What's the per-turn cost look like?

JIMMY: So each DM turn involves multiple LLM calls: the Slow Thinker evaluation on Opus, the Fast Thinker response on Sonnet, and the Scribe extraction. Plus any skill check DC table generation. The cost per turn varies significantly based on context window size, prompt caching strategy, and how frequently the Scribe runs.

I'll be honest -- the spec flagged this as the single most important business viability constraint. LLM costs are 85-95% of total operating costs. Infrastructure is noise in comparison. A session might cost $1-3 in API calls depending on length and model choices. The session pack pricing has to be validated against actual per-turn costs before launch.

MARCUS: What specific optimizations are you planning?

JIMMY: Several. First, prompt caching -- Anthropic supports it. The system prompt and world context are relatively static across turns, so caching those saves significant input tokens. Second, Scribe batching -- the Scribe doesn't need to run after every single turn. Maybe every 3-5 turns, or only when the ST identifies something worth extracting. Third, model selection per stage -- the Scribe might not need Opus. Sonnet or even a smaller model could handle fact extraction. Fourth, the running summary is key -- instead of feeding the entire conversation history to the ST, we maintain a compressed running summary that the ST updates each turn.

MARCUS: Let's talk about the auto-trigger latency. Player sends a message, 2-3 second debounce, then Haiku classification, then if triggered: Opus ST evaluation, then Sonnet FT streaming. What's the total latency?

JIMMY: Let me think through this. Debounce: 2-3 seconds. Haiku classification: probably 200-500ms. Opus ST evaluation: 5-15 seconds for the first token, depending on context size. Sonnet FT streaming: first token in 1-3 seconds, then streaming.

So from last player message to first visible DM text: roughly 8-20 seconds. That's... honestly on the slow side for a chat experience. The `dm_thinking` indicator helps -- players see the DM is working. And in a multiplayer setting, players are chatting with each other during that window, so the delay is less noticeable than in a 1:1 single-player game.

MARCUS: Could you skip the ST on some turns? Like only invoke Opus when something plot-relevant happens?

JIMMY: That's a great point. The ST doesn't need to intervene on every turn. For simple conversational exchanges -- a player asks an NPC about the weather -- the FT can handle that alone. The classifier that decides whether to trigger the DM could also classify the complexity level. Low-complexity turns skip the ST entirely, saving 5-15 seconds of latency and the Opus cost. The ST would run every N turns or when the classifier detects something narratively significant.

MARCUS: Now, the enforced ignorance boundary. You said it's architectural, not prompt-based. But the ST's direction field is a natural language string that crosses the boundary. How do you prevent information leakage there?

JIMMY: The primary defense is the ST system prompt -- directions describe behavior, not information. "The merchant becomes nervous" not "the merchant is the assassin." But that's a prompting defense, which you're right to be skeptical of.

The secondary defense is automated validation. We do substring matching against secret-level facts from the world store. Before the direction is passed to the FT, we check whether any secret fact content appears verbatim in the direction. If it does, we strip the direction and log a warning.

The tertiary defense is the adversarial test suite -- automated red-team prompts that try to extract secrets through the full pipeline, run in CI on every prompt template change.

MARCUS: What about paraphrasing? The ST could write "the merchant has a hidden identity" instead of the exact text of the secret fact.

JIMMY: That's a good point, and I hadn't fully considered that. Substring matching catches verbatim leaks but not paraphrasing. You could use embedding similarity -- check if the direction's semantic meaning is too close to any secret fact. But that adds another LLM call or an embedding computation to every turn, which adds latency and cost. In practice, I think the stronger defense is that the FT doesn't know what to do with a paraphrased hint. If the direction says "the merchant has a hidden identity," the FT -- which has no knowledge of any hidden identity -- would just write a vague response. The player can't extract information that the FT doesn't have, even if the direction hints at it.

MARCUS: That's a fair argument. The architectural boundary is the real defense, and the direction filtering is defense in depth. OK, let's move to combat. Walk me through the debug-mode-first strategy.

JIMMY: The combat system has two layers. Layer 1 -- the combat shell -- is what we ship at launch if the full engine isn't ready. It handles combat trigger detection, transitions the session to combat mode, but instead of a rules engine, it uses manual or AI resolution. The DM describes what happens, and the system asks for the outcome. Someone types "the PCs defeated the goblins, Arin took 12 damage," and the system applies those state changes.

The key design decision is that both layers share the same interface: `startCombat()`, `resolveCombat()`, `getCombatState()`. The session controller doesn't know or care which layer is behind that interface. So Layer 2 -- the full 5e rules engine -- plugs in as a swap.

MARCUS: Tell me about the rules engine design.

JIMMY: Pure functions. Given a `CombatState` and a `CombatAction`, return a new `CombatState` and an `ActionResult`. No side effects. Every combat rule is testable in isolation. The engine enforces movement, attack rolls, spell slots, concentration tracking, action economy, all 14 SRD conditions, death saves -- the full mechanical layer.

For reactions and triggered effects, we use a stack model similar to Magic: The Gathering's stack. When an action triggers a reaction -- say a Counterspell against a spell -- the reaction goes on the stack. The stack resolves top-down, and reactions can trigger further reactions. Counterspell countering Counterspell is a real 5e edge case that this handles cleanly.

MARCUS: I like the stack model. How do you handle the timing window for reactions? In tabletop, the DM asks "does anyone want to react?" before resolving. In a real-time system...

JIMMY: Right, you can't have an indefinite pause. When an action that could trigger reactions is submitted -- say an enemy casts a spell -- the server checks which combatants have unspent reactions and relevant reaction abilities. It broadcasts a reaction window message with a timer -- say 10 seconds. Players with valid reactions see a prompt. If they react, it goes on the stack. If the timer expires with no reactions, the stack resolves.

For NPC reactions, the AI decides immediately -- no timer needed. The AI gets the action stack context and decides whether to use its reaction.

MARCUS: What about the AI-generated voxel maps? The spec says no template fallback. That's a bold stance.

JIMMY: It is. The approach is: when combat triggers, the AI describes the battlefield via a structured tool call -- room dimensions, features, entrances, elevation, hazards. This is structured JSON, not freeform text. Then a deterministic map compiler translates that description into a VoxelMap using a library of primitives -- walls, pillars, stairs, tables, trees. The compiler is not AI -- it's regular code mapping descriptions to voxel geometry.

The bet is that LLMs are good at structured spatial description, and the compiler is the reliability layer. If the AI output is valid JSON matching the schema, the compiler will always produce a valid map. The failure mode is the AI producing invalid JSON, which is handled by the existing structured output repair chain.

MARCUS: And the combat-to-narrative handoff?

JIMMY: When combat ends, the rules engine produces a CombatSummary -- outcome, rounds elapsed, casualties, dramatic moments like critical hits or death save successes, resources expended, HP changes. That summary flows into three places: the Slow Thinker's context for post-combat narrative direction, the Fast Thinker's context as a prose summary, and the Scribe for fact extraction -- NPC deaths, PC injuries, conditions applied. Without this, post-combat narration ignores what happened in combat, which would be a terrible player experience.

VIVIAN: Let me throw some curveball scenarios at you. First: the Anthropic API goes down for 30 minutes during peak hours. 200 active sessions. What happens?

JIMMY: OK. The immediate impact is that no DM responses can be generated. The auto-trigger and explicit @DM triggers will fail. The retry strategy is exponential backoff -- 1 second, 2 seconds, 4 seconds, three attempts. After three failures, the session receives an error message.

But the sessions themselves don't crash. Players can still chat with each other via WebSocket -- that doesn't touch the LLM at all. Session state in Redis is fine. The sessions enter a paused state where the DM is unavailable.

When the API recovers, sessions resume. The DM picks up where it left off using the conversation history and running summary. No data is lost.

The operational side: we'd have a CloudWatch alarm on LLM API error rate exceeding 10%, which would fire SMS alerts. The dashboard shows LLM API health. And honestly, at that scale, there's not much to do except wait for Anthropic to recover. We could potentially have a fallback to a different provider -- like switching from Opus to a different model for the ST -- but that's a significant quality trade-off and would need careful testing.

VIVIAN: What about the pipeline worker? If someone's in the middle of world generation?

JIMMY: BullMQ handles that. The job fails and goes into the retry queue with exponential backoff. The pipeline_runs table shows the stage as 'running' -- the job's stalled detection kicks in, marks it failed, and it retries when the API is back. The user sees the pipeline status as stalled in the UI. Pipeline stages are designed to be resumable -- they pick up from the last completed stage, not from scratch.

VIVIAN: OK. Second curveball: a popular world gets 1,000 forks in one hour. What breaks?

JIMMY: Let me think about this. Each fork is a deep copy of 500-800 rows across 6-7 tables. That's 1,000 transactions, each inserting maybe 700 rows. So roughly 700,000 INSERTs in an hour. On a t4g.micro with gp3 storage at 3,000 IOPS baseline... that's about 12 inserts per second sustained. That's well within IOPS capacity.

The bottleneck would be connections. If all 1,000 fork requests arrive near-simultaneously, the API containers need connection pool capacity. At 4 containers with 10 connections each, that's 40 concurrent connections. The fork operations are fast -- sub-second each. So even with queuing at the connection pool, the throughput is probably fine.

The real issue might be the source world row. Every fork increments the `fork_count`, so that's 1,000 UPDATEs to the same row. With separate transactions for the fork count, you still get row-level lock contention. You could batch the counter updates, or use a distributed counter that's periodically flushed. But honestly, 1,000 forks in an hour of the same world would be an amazing problem to have, and the fix is straightforward.

VIVIAN: What about the write volume to the entities table? You're creating 1,000 copies of 40 NPCs.

JIMMY: 40,000 new entity rows. With UUIDv7, those are append-only B-tree inserts -- no page splits. The entities index would grow by maybe 5-10MB. That's fine for the database. The bigger concern might be the total database size -- if every user forks the same world, you've got a lot of duplicated data. At some point, copy-on-write semantics would be more efficient than full deep copies. But that's a significant architectural change that's not justified until the duplication is actually causing storage or performance issues.

VIVIAN: Good. That copy-on-write observation shows you're thinking about long-term evolution. Third curveball: a player discovers they can extract NPC secrets through clever prompting. How do you prevent this?

JIMMY: The primary defense is the enforced ignorance architecture. The Fast Thinker -- which generates all player-facing prose -- literally does not have access to secret facts. It receives only public-level facts via the prose kernels and a validated `ft_context`. Even a perfect prompt injection attack against the FT can't extract information that isn't in its context window.

The attack vector is the Slow Thinker's direction field, as we discussed. If a player crafts messages designed to make the ST write a direction that leaks information, and that direction passes through to the FT, that's the vulnerability. The defenses are: prompt engineering on the ST to produce behavioral directions, automated validation filtering, and the adversarial test suite.

There's also a social engineering angle -- a player could try to manipulate the FT into inventing secrets. "The merchant is secretly evil, right?" The FT might agree just to be cooperative. The defense there is prompt engineering: the FT is instructed to stay within its known context and not confabulate.

MARCUS: Fourth curveball: you need to add voice chat in 6 months. How does the architecture support this?

JIMMY: Hmm. Voice chat is a fundamentally different real-time communication pattern. WebSocket-based text chat is low-bandwidth, high-latency-tolerant. Voice is high-bandwidth, low-latency-critical. You need WebRTC for peer-to-peer voice, or a media server for mixing.

The architecture supports it in a few ways. The session management layer already tracks participants and their connection state. The Redis pub/sub channel per session could carry signaling messages for WebRTC peer connection establishment. The campaign membership and authentication systems already handle who's allowed in the session.

What I'd add is a signaling endpoint -- either over the existing WebSocket or a dedicated one -- that handles WebRTC offer/answer/ICE candidate exchange. The actual voice data would flow peer-to-peer between clients, not through our servers. That keeps our infrastructure costs unchanged for voice.

For speech-to-text integration with the DM, that's more interesting. We could use a client-side speech-to-text API -- browser native or Whisper -- to transcribe voice to text, then feed it through the existing text-based DM trigger system. The DM still responds in text, streamed via WebSocket. Voice-in, text-out as a first iteration.

MARCUS: That's a practical incremental approach. You're right that WebRTC keeps the media off your servers.

VIVIAN: OK, I think we've covered the major areas. Marcus, anything else?

MARCUS: One more thing. The session budget -- you have a token budget per session, and at 80% you warn, at 90% the ST triggers wind-down. What happens if the last DM response pushes from 85% to 95% in one turn? You've already streamed the response to the player.

JIMMY: The budget check happens before each LLM call, not after. Before initiating the FT call, we check the accumulated usage. If we're approaching the limit, we adjust. At 80%, we send the warning. At 90%, the ST's next evaluation includes an instruction to wind down the session gracefully. The FT response that pushes us over is the wind-down response itself -- it's designed to bring the session to a narratively satisfying pause point. We don't hard-cut mid-response.

The edge case is a very long FT response that blows past the budget. But Sonnet streaming tokens are metered in real-time. If the output exceeds a hard ceiling -- say 120% of budget -- we could cancel the stream. But in practice, a wind-down instruction produces a shorter response, not a longer one.

MARCUS: Makes sense. I'm good.

VIVIAN: Same. Jimmy, thanks for the thorough walkthrough. We'll follow up with our feedback.

JIMMY: Thanks, Vivian, Marcus. I appreciated the questions -- especially the direction-field leakage probing. That's an area I want to invest more in before launch.

---

## Scoring

| Category | Score | Justification |
|----------|-------|---------------|
| **System Topology** | 4.5/5 | Clean separation of API and Worker services with a clear bulkhead rationale. Stateless API design with Redis for coordination is well-architected. The single Redis node at launch is a calculated risk that Jimmy articulated honestly. Minor deduction: the architecture doesn't address what happens if the Worker service falls behind -- there's no back-pressure mechanism from BullMQ to the API layer to throttle new pipeline requests. |
| **Data Model** | 4.5/5 | The world/campaign fork model is elegant and future-proof. UUIDv7 for append-only B-tree performance, NUMERIC for money, credit ledger over simple integer -- all strong choices with clear rationale. The session_messages append-only table replacing the JSON blob is a significant improvement. Minor deduction: the fork deep-copy approach doesn't scale to very large worlds, and Jimmy acknowledged but did not propose a concrete migration path to copy-on-write. |
| **Real-Time Communication** | 4/5 | Correct Redis pub/sub pattern with per-session channels and selective subscription. Monotonic sequence numbers via Redis INCR provide total ordering. The debounce-based auto-trigger is well-reasoned. Deduction: the client-side message buffer for out-of-order delivery was described somewhat hand-wavily -- the exact behavior when gaps persist needs more rigor. Also, the reconnection flow relies on loading "latest state from Redis" without specifying exactly which keys are needed and in what order. |
| **Scalability** | 4.5/5 | Excellent progression table with defined triggers for every component upgrade, all achievable via Terraform parameter changes. The scaling path from 1 to 4 API tasks with CPU and connection-based auto-scaling is well-designed. The step scaling for WebSocket connections avoids the feedback loop that target tracking would create. Deduction: no discussion of database read replicas for query-heavy workloads, and the single NAT Gateway is a known AZ-level single point of failure. |
| **Reliability & Failure Handling** | 4/5 | Honest about failure modes -- Redis as critical dependency, single-AZ RDS, single NAT Gateway. The 5-minute checkpoint strategy for Redis failure is practical. Graceful shutdown with SIGTERM handling, connection draining, and server_restart WebSocket message is well-designed. Deduction: the lock expiry scenario where a crashed container blocks DM responses for up to 120 seconds is a long window. Jimmy didn't discuss what the user experience is during that window or how to detect and mitigate stale locks faster. |
| **Cost Awareness** | 5/5 | Exceptional. Jimmy correctly identified that LLM costs are 85-95% of total operating costs and that infrastructure optimization is nearly irrelevant. The specific call-outs on Scribe batching, ST skip on low-complexity turns, prompt caching, and model selection per stage show deep understanding. The session-pack billing model is aligned with per-session profitability. The token budget system with graceful wind-down prevents runaway costs. |
| **Trade-off Articulation** | 4.5/5 | Jimmy consistently explained why choices were made and what was sacrificed. The fork_count separation from the deep copy transaction showed good concurrency intuition. The honest acknowledgment of the enforced-ignorance paraphrasing gap was better than a defensive non-answer. The voice chat answer showed pragmatic incrementalism. Minor deduction: on the lock TTL question, Jimmy explained the mechanism well but didn't compare alternatives (e.g., shorter base TTL with more aggressive heartbeat). |
| **Overall** | **31/35 (88.6%)** | |

**Recommendation: STRONG HIRE**

Jimmy demonstrated staff-level system design thinking: clean service boundaries, honest about trade-offs, strong cost awareness, and the ability to think through edge cases under pressure. The architecture is well-reasoned for the target scale with defined paths to grow beyond it. The weakest areas -- reconnection rigor and stale lock detection -- are implementation details, not architectural mistakes. The combat stack model and enforced-ignorance boundary show creative problem-solving. The cost awareness alone puts this candidate above most -- too many candidates optimize infrastructure and ignore the 95% of the bill that comes from API calls.

---

## Out of Character: Recommendations

These are specific changes to the Mythrun architecture that would address the weaknesses exposed during the interview:

1. **Define a concrete reconnection protocol.** The current specs describe reconnection at a high level ("load state from Redis, replay from session_messages") but don't specify the exact sequence of Redis keys read, the order of operations, or what happens if Redis state is partially missing (e.g., ft_history is evicted but session state is present). Write a step-by-step reconnection flow with explicit handling for each partial-state scenario.

2. **Add stale lock detection.** The 120-second lock TTL means a crashed container can block DM responses for up to 2 minutes. Add a `dm_responding` flag with a separate, shorter TTL (e.g., 30 seconds, renewed by heartbeat). If the flag expires but the lock is still held, a new container can break the lock, knowing the holder is likely dead. This reduces the stale lock window from 120 seconds to ~30 seconds.

3. **Add back-pressure from Worker to API.** If the BullMQ pipeline queue is backed up (e.g., Anthropic rate limits, slow Opus responses), the API should reject or delay new world generation requests rather than queueing them indefinitely. Expose a queue depth metric and return 503 with Retry-After when depth exceeds a threshold.

4. **Plan the copy-on-write migration path for world forks.** The deep-copy approach works at launch but creates O(N) storage growth per fork. Document the specific trigger (e.g., source worlds exceeding 1,000 forks or total entity table exceeding 10M rows) and the migration approach (shared entities with a campaign-specific overlay table for modifications, keyed by `modified_by_play`).

5. **Add embedding-based direction filtering.** The substring matching for ST direction leakage catches only verbatim leaks. Pre-compute embeddings for all secret-level facts at session start, then compute the direction's embedding and check cosine similarity. Flag directions with similarity above a threshold for review or replacement. This can run asynchronously (don't block the response path) and log violations for prompt improvement.

6. **Model the ST-skip optimization explicitly.** The interview surfaced the idea of skipping the Slow Thinker on low-complexity turns. This should be designed and costed: what percentage of turns can skip the ST, what's the latency improvement, what's the cost saving, and what's the quality trade-off. This single optimization could be the difference between profitability and loss per session.

7. **Add a NAT Gateway redundancy upgrade to the progression table.** The single NAT Gateway in public-a is documented as a known risk but is missing from the scale-up triggers table in the infrastructure spec. Add it: "AZ-a outage unacceptable -> add second NAT Gateway in public-b, update route tables ($32/mo)."

8. **Specify the client-side message ordering buffer.** The handwave about "holding seq 5 and waiting for seq 4" needs a concrete implementation spec: buffer timeout (200ms was mentioned but not committed to), maximum gap size before requesting server replay, and behavior when the gap spans a DM streaming response (where seq numbers increment rapidly).
