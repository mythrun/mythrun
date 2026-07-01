// Type ROLE → full, STATIC Tailwind class string for each typographic role in
// the brand's narrative-serif / machine-mono system (MYT-82 §4 — see
// `@mythrun/client-core/tokens/scales` TYPE_ROLES, the data source of truth).
//
// Why a literal lookup and not interpolated classes: Tailwind v4 scans SOURCE
// TEXT for class names (same reason as `space.ts` GAP_CLASS). A
// template-built class never appears in the source, so its utility is never
// generated. Each value below is a COMPLETE literal so the scanner finds it.
//
// Each string composes four facets from TYPE_ROLES:
//   • family  — serif → `font-body` (--font-body), mono → `font-ui` (--font-ui)
//   • size    — the matching `text-*` token where one exists at the exact rem
//               (text-base=1rem, text-lg=1.125rem, text-sm=.875rem,
//               text-xs=.75rem, text-3xl=2.25rem); `heading` is 1.25rem, which
//               has NO named token, so `text-[1.25rem]` (non-color arbitrary →
//               allowed by no-ad-hoc-color, like `gap-[var(--space-N)]`).
//   • lineHeight — pinned per role via `leading-[<n>]`: the named token's
//               default line-height does NOT always equal the role's (e.g.
//               text-lg defaults 1.6 but `title` wants 1.4), so we set it
//               explicitly to honour TYPE_ROLES exactly.
//   • weight/transform/tracking — `font-normal|medium|semibold` (Tailwind's
//               built-in weight utilities = 400/500/600, matching
//               --weight-*), plus `uppercase` + `tracking-wide` (--tracking-wide
//               = 0.5px) for `ui-label`.

/** Every typographic role across {@link Text} (prose/subtitle/ui/data/meta) and Heading (display/heading/title). */
export type TypeRole =
  | 'display'
  | 'heading'
  | 'title'
  | 'prose-body'
  | 'subtitle'
  | 'ui-label'
  | 'ui-caption'
  | 'data'
  | 'meta'

// `subtitle` and `meta` add a COLOUR facet the other roles leave to the ambient
// ink: both carry `text-ink-secondary` (the muted TEXT token — a utility, so it
// flips correctly under `.dark`, unlike a frozen `var(--color-*)`). `subtitle` is
// the italic serif narrative sub-line; `meta` is the quiet mono record line.
/** Type role → its complete static token class string. */
export const TYPE_ROLE_CLASS: Record<TypeRole, string> = {
  display: 'font-body text-3xl font-semibold leading-[1.2]',
  heading: 'font-body text-[1.25rem] font-semibold leading-[1.3]',
  title: 'font-body text-lg font-semibold leading-[1.4]',
  'prose-body': 'font-body text-base font-normal leading-[1.6]',
  subtitle: 'font-body text-sm font-normal italic leading-[1.4] text-ink-secondary',
  'ui-label': 'font-ui text-sm font-medium uppercase tracking-wide',
  'ui-caption': 'font-ui text-xs font-medium',
  data: 'font-ui text-sm font-normal',
  meta: 'font-ui text-xs font-normal text-ink-secondary',
}
