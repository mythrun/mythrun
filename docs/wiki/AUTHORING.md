# Wiki Authoring

How to write and update pages in the Mythrun internal wiki. Read this first if you're authoring content — by hand or as the wiki-update subagent.

---

## The seven principles

These are the durable rules that apply on every page, every edit, every dispatch.

1. **Illustrative, not instructional.** Pages teach how the system fits together and what the pieces do — enough detail for a reader to hold an accurate mental model, NOT enough for an engineer to re-implement from. If a page reads like a spec or a copy of `main.tf`, it's wrong.

2. **Explainer, not reference.** Pages are front-to-back narratives. The reader starts at the top and learns as they scroll. Reference material (variable tables, resource inventories, config enumerations) is demoted to an Appendix at the bottom of each page.

3. **Story-shaped, not artifact-shaped.** One page per coherent concept, which may span multiple source artifacts. "CI/CD" is one page covering the workflow + OIDC trust + IAM role + SNS alerts — they're one system, one story. A source artifact with no independent story becomes a section of a larger page, not its own page.

4. **Diagram-central.** Every non-trivial page has a DOT diagram near the top, right after the lead. The prose refers to the diagram and walks the reader through its pieces. Diagram and prose are co-authored; neither stands alone.

5. **Rationale when non-obvious, as inline callouts.** If a reader might reasonably ask "why this way and not another?", the page answers — AT the point in the narrative where the decision is first mentioned, as a `<aside class="wiki-rationale">` callout. Conventional choices (TCP/443, three AZs) get no callout. Real tradeoffs do.

6. **Scope: built + integrations + runbooks.** In-scope: shipped code and infra on `main`, integration surfaces with external services (what we call, what we listen for, where configs live), and operational procedures for shipped pieces. Out-of-scope: external-service internals, rejected approaches, future plans.

7. **Default stance: author rather than skip.** When it's ambiguous whether a change warrants a page update, author the update. Too-detailed pages are easier to prune later than silent staleness is to catch.

---

## Narrative vs Reference pages

The wiki holds two kinds of pages and they have different rules.

**Narrative pages** live in topical sections (`Infra`, `Runtime`, `Data`, `Auth & Billing`, `World & Campaign`, `Combat`, `Frontend`). They are story-shaped explainers, hand-authored, governed by the seven principles above and the canonical page spine below. One page per coherent concept; the reader scrolls front-to-back to learn how the system fits together.

**Reference pages** live in the top-level `Reference` section. They are derived views — auto-aggregated from other pages or auto-generated from upstream artifacts (migrations, Terraform, etc.). The reader arrives with a specific question ("what runbooks exist for the data plane?", "which tables CASCADE on user deletion?") and uses the page as a tool. The seven principles and the canonical spine apply to narrative pages; reference pages have their own minimal shape:

1. `<h1>` title.
2. `<p class="lead">` — one sentence on what the page is for.
3. (Optionally) source comments at the top declaring the upstream artifacts.
4. A marker the build replaces with generated content (e.g. `<!-- @runbooks-index -->`, `<!-- @schema-reference -->`).

Reference pages don't carry diagrams, "How it fits together" sections, or rationale callouts. The narrative explainer for the same subject does. The schema reference at `reference/schema.html` complements the narrative explainer at `data/schema.html` — same subject, two different use cases.

**Adding a new reference page** means deciding (a) what upstream artifact it derives from, (b) what marker the build will replace, and (c) which page in the topical sections is the narrative complement (cross-link both ways). See "Auto-generated reference pages" below for the marker mechanism.

---

## Canonical page spine

Every page that documents a piece of the system follows this order. Sections are skipped when empty — no hollow placeholders.

1. **`<h1>` title** — the story's name.
2. **Lead paragraph** (`<p class="lead">`) — one sentence answering "what is this and why does it exist?"
3. **Diagram** (`<!-- @diagram: <section>/<name> -->`) — the mental-model anchor. Inline SVG.
4. **How it fits together** — narrative `<h2>` sections walking the reader through the pieces, referring to the diagram. This is the bulk of the page. Rationale callouts appear inline inside this narrative at the point where each non-obvious decision is first mentioned.
5. **Operating this piece** — runbook entries if applicable. Exact `<h2>` text: `Operating this piece`. Each `<h3>` under it is a runbook title; its body is an ordered list of steps. The build scans this section to populate the top-level Runbooks index.
6. **Integration points** — inline prose links to other wiki pages this one relates to. Not a formal index; natural hyperlinks in prose.
7. **Appendix: inputs & outputs** — terse reference tables (Terraform vars/outputs, config flags, resource inventory). For the reader who already knows the story and needs a specific value. De-emphasized typography.
8. **Source** — `<code>infra/modules/network/</code>` pointer to the repo location.

### Example shape

```html
<!-- source: infra/modules/network/ -->
<!-- source-hash: sha256:<auto> -->
<!-- last-ticket: MYT-25 -->

<h1>Network</h1>

<p class="lead">The VPC everything else runs in. Three AZs, public/private split, single NAT.</p>

<!-- @diagram: infra/network -->

<h2>How it fits together</h2>

<p>The network module carves three AZs into public and private subnets.</p>

<aside class="wiki-rationale">
  <strong>Three AZs</strong> — ALB spreads across public subnets in all three for resilience. RDS
  multi-AZ uses two of them for its replica.
</aside>

<p>
  The public subnets hold the ALB. Private subnets route outbound traffic through a single NAT
  gateway.
</p>

<aside class="wiki-rationale">
  <strong>Single NAT (not HA pair)</strong> — staging doesn't need HA. A pair would double our
  ~$32/month NAT cost. Revisit when prod lands.
</aside>

<p>Security groups bind ingress and egress at the subnet layer…</p>

<h2>Operating this piece</h2>

<h3>Expand the CIDR range</h3>
<ol>
  <li>Edit <code>infra/modules/network/variables.tf</code>…</li>
  <li>Apply against shared workspace first…</li>
</ol>

<h2>Integration points</h2>

<p>
  Downstream: <a href="../infra/data.html">Data plane</a> places RDS and ElastiCache into these
  private subnets. <a href="../infra/serving.html">Serving</a>
  runs ECS tasks in them.
</p>

<h2>Appendix: inputs &amp; outputs</h2>

<table>
  …
</table>

<h2>Source</h2>

<p><code>infra/modules/network/</code></p>
```

---

## Page lifecycle

How to decide whether to add, merge, split, or delete pages.

- **Add a page** when a shipped change introduces a new coherent story that doesn't fit inside an existing page. Update `structure.ts` in the same commit.
- **Don't add a page** when the change is a small addition to an existing story. Fold it in as a new section or paragraph on the owning page.
- **Split a page** when it has grown to encompass two distinct stories a reader would expect to navigate to separately. Rare; default to keeping pages together.
- **Merge pages** when two pages tell fragments of one story, OR when one page is too thin (lead + three-sentence section + no diagram-worth-drawing).
- **Delete a page** when the underlying code/infra is removed from `main`. Delete the `structure.ts` entry in the same commit.

---

## Decision rubric for the subagent

What the subagent decides without asking, once a hook fires.

- **Which pages does this diff touch?** Map each changed source file to its owning page via `<!-- source: -->` declarations. If a file has no owning page, extend an existing page (preferred) or create a new one per the lifecycle rules.
- **Prose rewrite or just accept-drift?** Apply the **mental-model test**: if a reader's mental model after reading the current page would match reality after the change, run `pnpm wiki:accept-drift` with no content edits. If the page's narrative, diagram, or rationale callouts would mislead a reader, rewrite. Cosmetic changes (tag tweaks, variable renames that don't surface in prose, comment fixes) take the accept-drift path.
- **What to edit on a touched page?** Update the narrative, diagram, and rationale callouts to match reality. Regenerate the appendix from current source. Add new runbook entries when the issue introduces new human-action procedures.
- **When in doubt, author.** Too-detailed pages are easier to prune than missing ones are to discover.

---

## Page header comments

Every page that documents source material declares it:

```html
<!-- source: infra/modules/network/ -->
<!-- source: infra/modules/network/main.tf -->
<!-- source-hash: sha256:<auto-maintained> -->
<!-- last-ticket: MYT-### -->
```

- `source` — one comment per tracked path. File or directory. Relative to repo root.
- `source-hash` — maintained automatically by `pnpm wiki:accept-drift`. Do not hand-edit.
- `last-ticket` — the Linear issue that most recently caused the page to change. Optional for sourceless pages (landing, section overviews).

Pages without source declarations (landing, section overviews, the Runbooks index) are allowed; the build skips drift checks on them.

---

## Auto-generated reference pages

Reference pages whose body is generated by the build use a marker — an HTML comment the build pipeline replaces with rendered content. The pattern is:

```html
<!-- source: <upstream artifact path> -->
<!-- source-hash: sha256:<auto> -->

<h1>Title</h1>
<p class="lead">…</p>

<!-- @<marker-name> -->
```

Two markers exist today:

| Marker                       | Page                      | Source                                                          |
| ---------------------------- | ------------------------- | --------------------------------------------------------------- |
| `<!-- @runbooks-index -->`   | `reference/runbooks.html` | scans every page's `<h3>` under `Operating this piece`          |
| `<!-- @schema-reference -->` | `reference/schema.html`   | introspects `backend/migrations/*.sql` against a fresh Postgres |

When the upstream artifact changes, the page's source-hash drifts. The contributor:

1. Runs `pnpm wiki:build` (locally with `DATABASE_URL` set if the marker uses it). The build regenerates `site/<page>.html`.
2. Inspects the rebuilt page in `pnpm wiki:dev`.
3. Runs `pnpm wiki:accept-drift`. The hash in `content/<page>.html` updates.
4. Commits the upstream change AND the source-hash bump.

CI's `pnpm wiki:check` re-runs the generator and compares the hash. Forgetting step 3 is a red CI build with `drift: <page> (mismatch)`.

The hand-written shell of an auto-generated page (lead, integration points, framing prose) rarely changes — only the source-hash comment moves when an upstream change ripples through. Don't hand-edit between the markers; the build will overwrite.

---

## Authoring conventions

- First `<h1>` is the page title. Only one per file.
- Use `<h2>` for major sections, `<h3>` for subsections. Both appear in the right-column TOC.
- One-paragraph summary directly under the title: `<p class="lead">...</p>`.
- Rationale callouts: `<aside class="wiki-rationale"><strong>Label</strong> — explanation</aside>`. Placed inline at the paragraph where the decision is first mentioned.
- Inline code: `<code>...</code>`. Code blocks: `<pre><code>...</code></pre>`.
- Cross-links: `<a href="../infra/network.html">...</a>` — use relative paths.
- Embed a diagram: `<!-- @diagram: <section>/<name> -->` on its own line. The build inlines the rendered SVG.

### Voice

**Maker's workshop** — explanatory, documentary. Short sentences, present tense, specific nouns. Assume the reader knows the codebase. No hype. See `docs/wiki/BRAND.md` for the full voice rubric and visual guidance.

### DOT diagram conventions

Every diagram gets `layout/dot-header.dot` prepended automatically — brand-consistent defaults are free. Don't re-declare `graph`, `node`, or `edge` attributes unless overriding.

Color aliases:

- `"ember"` → `#8A5A3C` (substituted at build time; use as a string anywhere a color is accepted)

Use subgraphs (`subgraph cluster_foo { ... }`) to group logically related resources. Diagrams tell the architectural story — omit noise (per-resource tags, redundant IAM details, default-value outputs). Favor clarity over completeness.

---

## Build / check / accept-drift

```bash
pnpm wiki:dev              # serve on http://localhost:3100 with hot reload
pnpm wiki:build            # permissive — drift renders a banner, exit 0
pnpm wiki:check            # strict — drift exits non-zero (CI gate)
pnpm wiki:accept-drift     # rewrite source-hash comments for drifted pages
```

Typical authoring flow:

1. Edit a content file (or DOT source).
2. `pnpm wiki:build`.
3. Open `docs/wiki/site/<section>/<page>.html` or refresh the dev server tab.
4. If drifted and the page now reflects the new source, `pnpm wiki:accept-drift`.
5. `pnpm wiki:check` — must exit 0.
6. Commit content + regenerated `site/`.

---

## Wiki Update Subagent Prompt

The hook at `.claude/hooks/post-linear-close.sh` fires on every Linear `save_issue` call that transitions a state to `Done`. It emits a reminder directing the main agent to dispatch a subagent with this prompt. The `{{linearIssueId}}` placeholder is supplied by the main agent.

```
You are the Mythrun wiki-update subagent. A Linear issue just closed: {{linearIssueId}}.

Your job is to bring docs/wiki/ in sync with the code and infra changes this
issue introduced. The wiki covers the whole as-built Mythrun system — backend
code, AWS infrastructure (Terraform), and integration surfaces with external
services.

READ docs/wiki/AUTHORING.md FIRST. That document has the seven principles, the
canonical page spine, the page lifecycle rules, and the decision rubric. Apply
them. Everything below is procedure.

STEP 1 — UNDERSTAND THE ISSUE
Read the Linear issue via mcp__linear-server__get_issue with id={{linearIssueId}}.
Note: title, description, comments, any linked PRs.

STEP 2 — FIND THE CHANGES
Run `git log --all --grep={{linearIssueId}}` to find commits referencing the
issue. If none, fall back to commits on main since the last wiki commit
(`git log --format=%H -- docs/wiki/` — the first hash is the reference point).
For each commit: `git show --name-only <hash>`.

STEP 3 — MAP CHANGES TO PAGES
For each changed file, find its owning wiki page via <!-- source: --> declarations.
If a file has no owning page, decide — per the page-lifecycle rules in AUTHORING.md —
whether to extend an existing page (preferred) or create a new one.

STEP 4 — APPLY THE MENTAL-MODEL TEST
For each touched page, ask: would a reader's mental model after reading the
current page match reality after this change?
  - Yes → leave the page's content byte-identical. Record it as accept-only.
  - No  → rewrite the page per the canonical spine and the seven principles.

⚠️ `pnpm wiki:accept-drift` TAKES NO PAGE ARGUMENT. It is GLOBAL: build.ts's
parseMode only looks for the bare `--accept-drift` flag, and the pipeline then
stamps a fresh hash onto EVERY drifted page it renders. An earlier version of
this step read `pnpm wiki:accept-drift <page>`, which does not do what it looks
like — the path is silently ignored and all drifted pages are blessed, including
ones nobody has read. So do NOT run it per page as you go. Finish reviewing every
drifted page first, then run it once at the end, where "accept everything" is
true rather than a lie. When several agents are syncing in parallel, only the
controller runs it.

STEP 5 — AUTHOR (when rewriting)
Read the actual source files. Understand what changed and what the reader needs
to hold in their head. Then rewrite:
  - Keep or update the lead.
  - Update or regenerate the diagram to reflect current shape.
  - Rewrite the narrative; place rationale callouts at each non-obvious decision.
  - Add/update runbook entries under "Operating this piece" if the issue
    introduces new operational procedures.
  - Regenerate the Appendix from current source.
Never paste raw terraform graph output, raw tf blocks, or raw code. The wiki is
illustrative, not instructional.

STEP 6 — BUILD
pnpm wiki:build      # regenerates site/ including the Runbooks auto-index
pnpm wiki:check      # must exit 0
pnpm format:check    # must exit 0 — run `npx prettier --write docs/wiki/content/`
                     # if it flags any new pages you authored

If any of these fail, fix the underlying issue (missing source path, orphan
page, stale hash, prettier violation) and loop.

STEP 7 — COMMIT
Commit message:
  docs(wiki): sync for {{linearIssueId}} — <short description>

  <one-paragraph summary of what changed in the wiki and why>

Push to main.

BOUNDARIES
  - Do not modify build utilities under docs/wiki/build/. Content, diagrams,
    structure.ts, and site/ only.
  - Do not skip wiki:check.
  - If a page documents a file that was deleted in this issue, delete the page
    (and its structure.ts entry) rather than leaving a stub.
  - If the issue didn't touch anything the wiki currently documents, commit
    nothing and exit with a note. That's fine.
  - External-service internals, rejected approaches, and future plans are all
    out of scope — do not add them.
```
