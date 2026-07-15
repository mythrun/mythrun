# MYT-101 Session Opening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline; five small serial tasks). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session opens with a prep-generated, tripwire-vetted DM introduction, delivered deterministically at `POST /start` as the session's first `dm_text` row.

**Architecture:** The session-prep stage (Opus) gains a third output field, `opening` — player-facing prose following Miklos's table-opening formula. It is vetted by the existing secret tripwire (Haiku) against the same generation's `sd_playbook` before persist, stored in a new nullable `session_preps.opening` column, and delivered by `/start` after the debit via `sessionMessages.appendDmTurn` (one row, fresh `turnId`, seq from `sessionState.nextSeq`, `triggerKind: 'session_opening'`). No frontend work: the row replays as an ordinary settled DM message (WS replay covers first join; no socket can exist before `/start` returns, so persist-only delivery is provably sufficient), and the FT sees it as its own prior message in the transcript.

**Tech Stack:** Existing prep pipeline (generateObject + repair chain), `runSecretTripwire`, repo layer, Vitest.

## Global Constraints

- Enforced ignorance: `opening` obeys `ft_context`'s hard exclusions AND is tripwire-vetted (player-facing prose from an all-seeing model; confab is the known prep failure mode). A tripped opening FAILS the stage (retryable) — never persist a tripped opening.
- ZFC: delivery is mechanical (no LLM at `/start`). The LLM never generates the seq.
- `.min()` floor only on `opening` (no `.max()` on LLM prose).
- Prompt + schema co-evolve in the same task.
- Migration updates `migrate-schema.test.ts`'s pinned list + EXPECTED arrays (run the FULL backend suite).
- Fail-soft on legacy preps: `opening IS NULL` → session starts silent + loud WARN (mirrors the existing missing-prep fail-soft).
- Conventional Commits; TDD (failing test first) per task.

---

### Task 1: Migration — `session_preps.opening`

**Files:** Create `backend/migrations/034_session_opening.sql`; Modify `backend/src/db/__tests__/migrate-schema.test.ts` (pinned list + EXPECTED columns), `backend/src/repo/types.ts` (`SessionPrepRow` gains `opening: string | null`), `backend/src/repo/session-preps.ts` (SELECT/INSERT columns; `insert` input gains optional `opening`).

- [ ] Failing test: extend the migrate-schema pins (list + session_preps columns) → run FULL backend suite → RED on the pin.
- [ ] `034_session_opening.sql`: `ALTER TABLE session_preps ADD COLUMN opening TEXT;` (nullable — legacy rows fail soft).
- [ ] Repo: `insert` writes `opening` (NULL when absent); reads return it. Extend the session-preps repo test.
- [ ] `pnpm db:migrate` (dev) + full suite GREEN. Commit.

### Task 2: Prep schema + prompt — generate the opening

**Files:** Modify `backend/src/llm/prep/stages/session-prep.ts` (`sessionPrepSchema` gains `opening: z.string().min(100)`; return it), `backend/src/llm/prompts/prep/session-prep.txt` (Document 3 section), stage test.

**Prompt content (Document 3 — the formula, near-verbatim from Miklos):** a single flowing introduction the DM reads aloud at the top of the session. Session 1 only: open with a welcome line naming the world ("Welcome to [World], a world where …"). Then: where the party finds itself (the specific location, described in generalities); for sessions > 1 weave a short recap of how they got here from the prior-session summary INSTEAD of the welcome; what they can immediately see; what they hear and smell (ground the senses); one visible interactable — an NPC or thing that leads toward plot if engaged ("Over to the right you see …"); close with exactly "What do you do?". Known-tier only; same hard exclusions as `ft_context`; second person; no info-dumps; 150–350 words.

- [ ] Failing test: mocked-LLM stage test asserts `opening` present + parses through the schema (RED: schema lacks the field).
- [ ] Schema + prompt edits (update the "two distinct fields" framing to three; add the Document 3 section + length guidance).
- [ ] GREEN + eslint. Commit.

### Task 3: Tripwire vet in the processor + persist

**Files:** Modify `backend/src/llm/prep/session-prep-processor.ts` (vet → insert `opening`), its test.

- [ ] Failing tests: (a) processor passes `opening` through to `repo.sessionPreps.insert`; (b) a `runSecretTripwire` result with `tripped: true` (match the real result shape in `backend/src/llm/secret-tripwire.ts`) → stage throws (prep-failed path, retryable) and NOTHING persists.
- [ ] Implement: after `generateSessionPrep`, `runSecretTripwire({ prose: result.opening, secrets: result.sd_playbook })`; tripped → throw `Error('session-prep: opening tripped the secret tripwire')`; clean → include `opening` in the insert. Add the tripwire's usage to the stage cost (mirror the scribe's cost handling).
- [ ] GREEN. Commit.

### Task 4: `/start` delivery

**Files:** Modify `backend/src/routes/sessions.ts` (after `resetSessionKeys`, before the 200), its route test.

- [ ] Failing tests: (a) `/start` with a prep row carrying `opening` → exactly one `session_messages` row exists for the new session: `message_type='dm_text'`, `content=opening`, `seq=1`, non-null `turn_id`, `trigger_kind='session_opening'`, `user_id IS NULL` — and a subsequent `nextSeq` returns 2 (the counter advanced); (b) prep row with `opening IS NULL` → zero rows + the WARN log fires; (c) the existing /start contract tests stay green.
- [ ] Implement:
  ```ts
  if (prep?.opening != null) {
    const seq = await sessionState.nextSeq(campaignId)
    await repo.sessionMessages.appendDmTurn({
      sessionId,
      turnId: uuidv7(),
      rows: [{ kind: 'dm_text', content: prep.opening }],
      seqs: [seq],
      triggerKind: 'session_opening',
    })
  } else {
    log.warn({ campaignId, sessionId, sessionNumber }, 'session_start.no_opening')
  }
  ```
  Verify `trigger_kind` carries no CHECK constraint (grep migrations); if the post-session analysis excludes rows by trigger kind, confirm `'session_opening'` rows should be INCLUDED in analysis (they are real fiction) — adjust the exclusion list only if it is an allowlist.
- [ ] GREEN + full backend suite + typecheck + lint. Commit.

### Task 5: Real-LLM verification + ship

- [ ] Trigger session-prep on the fresh campaign (`tmp/fresh-campaign-id.txt`) via `POST /api/campaigns/:id/session-prep` (real Opus). Poll the prep row; READ `opening` verbatim: assert structure (welcome line naming the world, location, senses, one interactable, ends "What do you do?"), known-tier eyeball, tripwire log clean.
- [ ] Do NOT start the session (Miklos's live moment). The delivery path is integration-tested; the settled-dm replay render is already live-proven (the seeded-row experiment).
- [ ] Wiki subagent (AUTHORING.md, MYT-101) → single local commit → push through the gate → CI green → flip MYT-101 Done.

## Self-review notes

- Seq collision with the turn worker: impossible — both consume the same Redis `:seq` INCR; the opening takes 1, the first turn starts at 2. The fresh-session comment in `/start` ("no reseed; nextSeq returns 1") is exactly the slot the opening occupies.
- Reconnect/first-join: `seedLastSeq(0)` full-history replay delivers the opening to every joiner; dm_text is codec-registered since MYT-92.
- `SafeSessionPrep` deliberately does NOT gain `opening` (no consumer; YAGNI — the wire surface stays minimal).
- MessageStream/reducer: a dm_text row with an otherwise-unseen turnId folds as a settled dm item (proven live by the seeded-row experiment on 019f6275).
