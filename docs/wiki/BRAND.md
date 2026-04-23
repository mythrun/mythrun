# Wiki Brand Brief

Scoped subset of the Mythrun brand, sufficient for styling the internal wiki. Full brand system lives in `mythrun-design/` (separate repo) — read that only if a question isn't answered here.

## Palette (wiki-scoped)

Six tokens cover every surface the wiki needs:

| Token | Hex | Role on the wiki |
|-------|-----|------------------|
| `paper-100` | `#EFE9DC` | Page background |
| `paper-300` | ≈`#C9C0AD` | Borders, dividers, table rules, code-block outlines |
| `paper-500` | `#877F72` | Captions, metadata, timestamps, breadcrumb separators |
| `paper-700` | `#3D3528` | Secondary body copy (sub-headers, blockquote text) |
| `paper-900` | `#231B12` | Primary text, headings |
| `ember-600` | `#8A5A3C` | Links, active-nav indicator, callouts — accent only |

Default every composition to `paper-900` on `paper-100`. Ember is an accent, never a ground. Semantic colors (success/warning/danger/info) exist in the full palette but are UI-state only — the wiki has no UI state, so don't use them. If a wiki page genuinely needs a callout variant (e.g. "deprecated," "draft"), use ember for emphasis and a paper-700 label, not red/green.

Dark mode (if ever added): `paper-100` text on `paper-900` ground. Never white-on-black.

## Typography

Three faces. All load from Google Fonts.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,300..900;1,8..60,300..900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

| Face | Use |
|------|-----|
| **Source Serif 4** | Body prose, headings, long-form doc text. Default for anything a reader reads as sentences. |
| **IBM Plex Mono** | Nav chrome, sidebar, breadcrumbs, button/tab labels, inline `code`, code blocks, data readouts, file paths, timestamps. Anything "computational-but-crafted." |
| **Tyma Garamont Regular** | Wordmark only. **Not a CSS font.** The wordmark is deployed exclusively from the SVG lockup assets in `assets/`. Never typeset "Mythrun" fresh in CSS. |

The contrast between serif prose and monospace chrome is deliberate — it mirrors Mythrun's narrative-vs-mechanical-state separation. Don't blur it (e.g. don't set nav labels in Source Serif 4 to "match" the prose).

Suggested sizing (not locked, adjust to taste):
- Body prose: Source Serif 4, 17–18 px, line-height ≈ 1.6
- H1: Source Serif 4, ≈ 34 px, weight 400–500
- H2: Source Serif 4, ≈ 24 px, weight 500
- H3: Source Serif 4, ≈ 19 px, weight 600
- Nav / sidebar labels: IBM Plex Mono, 13–14 px, weight 500
- Inline code / paths: IBM Plex Mono, 0.92em of surrounding text
- Captions / metadata: IBM Plex Mono or Source Serif 4 italic, 13 px, paper-500

## Logo usage

Assets live in `docs/wiki/assets/`. All SVGs render crisp at any size.

| File | Use |
|------|-----|
| `favicon.svg` | Browser tab favicon. **Deliberately off-brand** — saturated info-blue `#1A7DC4` (extreme of the info ramp) instead of ink. This is a dev-tool convention: the wiki tab is visually distinct from the Mythrun product's own ink favicon, so if both are open in a browser at once they're instantly differentiable. The logomark shape is unchanged; only the color. |
| `lockup-horizontal-primary.svg` | Header / top nav bar — the canonical horizontal-space lockup. |
| `lockup-stacked-primary.svg` | Wiki landing/cover page, larger branded surfaces. |
| `lockup-horizontal-reverse.svg` | Reserved for dark-ground compositions (e.g. dithered footer, if ever added). |
| `mark-ink.svg` | Standalone logomark on cream — inline or section dividers. |
| `mark-primary.svg` | Standalone ember logomark — reserved, rarely used. |

**Scaling:** SVGs are fine at any size, but the underlying mark is pixel art. Don't apply `filter`, smooth scaling, or effects to the rendered `<img>`. Render with `image-rendering: pixelated;` if the mark ever appears at non-native pixel ratios and looks soft.

**Minimum mark size:** 48×48 for the canonical 64 mark. Below that, use the favicon.

**Clear space:** 1× cap-height of clear space around any lockup. Don't crop it flush against page edges.

## Texture · dithered gradients

Mythrun does **not** do smooth CSS gradients. If the wiki ever wants a mood-setting surface (landing-page hero, section transition, error page), it must be a stepped 4×4 Bayer dither between two paper steps — or the canonical `paper-100 → ember-600` vertical band.

For the v1 wiki, assume no gradients. Plain `paper-100` ground everywhere, with solid rules or whitespace as section dividers. If a later iteration wants a hero treatment, request the dither CSS from `mythrun-design/brand/guidelines.md` → Texture before implementing.

**Forbidden on the wiki:** `linear-gradient()`, `radial-gradient()`, any CSS filter blur or shadow on brand elements, drop shadows on the mark, ember as a background, ember as body text color.

## Voice for doc prose

The wiki is **Maker's workshop** sub-mode — explanatory, documentary. Not session-log atmospheric, not marketing. Pages should read as a thoughtful engineer explaining how a system works to another engineer.

Keep:
- Short sentences, one idea each.
- Specific nouns — *the Fast Thinker*, *the Scribe*, *the repository layer*. Not "the system," not "components."
- Present tense for describing how things work; past tense only for narrating historical decisions.
- Dry wit, sparingly. Only if it's also true.

Avoid:
- Hype ("powered by," "next-generation," "ultimate," "revolutionary").
- Exclamation points.
- First-person plural "we" — the wiki is documentation, not pitch deck.
- Filler transitions ("it's worth noting," "as mentioned previously").

## Don'ts

- No smooth gradients anywhere.
- No drop shadows, glows, or effects on the mark or lockups.
- No recoloring the mark outside the canonical variants in `assets/`.
- No text in ember (accessibility — ember on paper-100 is marginal).
- No ember as a background.
- No dual-color ember-mark + ink-wordmark lockups (lockups are monochrome; use the provided SVGs as-is).
- No typesetting "Mythrun" fresh in CSS — always use the SVG wordmark/lockup.
- No rotating, flipping, or stretching any brand asset.

## When in doubt

Default to `paper-900` on `paper-100`. Default to Source Serif 4 for prose, IBM Plex Mono for chrome. Default to the horizontal lockup in the header. Default to generous whitespace. Default to quiet.

If a decision feels too loud, it is. Make it quieter and try again.
