# Mythrun Internal Wiki

Agent-maintained, as-built visualization of the whole Mythrun system — code and AWS infrastructure. For the single reader (Miklos); not a public docs site.

Open `site/index.html` in a browser to view. Every HTML file works directly via `file://` — no dev server required.

## Commands

```bash
pnpm wiki:build            # rebuild site/ (permissive; drift renders a banner)
pnpm wiki:check            # strict build (used in CI; non-zero on drift)
pnpm wiki:accept-drift     # lock source hashes after updating a page
```

## Files

- `BRAND.md` — visual conventions for the wiki (scoped subset of Mythrun brand).
- `AUTHORING.md` — how to author pages, plus the wiki-update subagent prompt template.
- `structure.ts` — nav source of truth. Every page is declared here.
- `content/` — HTML fragments, one per page.
- `diagrams/` — DOT files, rendered to SVG at build time.
- `layout/` — shell, styles, client JS.
- `assets/` — logos, favicon (saturated info-blue — dev-tool color, not brand ink).
- `build.ts` + `build/` — TypeScript build pipeline.
- `site/` — generated HTML. Committed.

## How it stays current

A Claude Code PostToolUse hook fires on Linear issue close and dispatches a wiki-update subagent whose prompt is in `AUTHORING.md`. Every page also declares its tracked source paths; `pnpm wiki:check` (run in CI) fails on drift so the wiki can't silently fall out of sync.

Design spec: `docs/superpowers/specs/2026-04-23-internal-wiki-design.md`.
