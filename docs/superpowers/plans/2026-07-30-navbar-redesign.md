# NavBar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the app header per `docs/superpowers/specs/2026-07-30-navbar-redesign-design.md` — fluid-sized brand lockup, name-as-menu desktop, hamburger mobile, honest billing IA, scroll-elevated hairline with zero CLS.

**Architecture:** Five small design-system extensions (Menu entries/width/dark-highlight, HorizontalLockup fluid mode, Button trailing-icon+truncate, `chrome` type role, new `StickyBar` primitive owning ALL scroll-visual mechanics), one web platform hook (`useScrollElevation`), then the web-layer rewrite (routes rename, `HeaderMenu`, `AppFrame`). DS work lands first in parallel; web work composes it.

**Tech Stack:** React 19, Radix `DropdownMenu`, Tailwind v4 (source-scanned literal classes only), vitest + Testing Library, Storybook + CI overflow/a11y sweep, i18next (typed keys from `client-core/src/i18n/locales/en/common.json`).

## Global Constraints

- Spec is source of truth: `docs/superpowers/specs/2026-07-30-navbar-redesign-design.md` (v2). Scroll-mechanics section is NORMATIVE.
- No `className`/`style` in app code on DS components (BaseProps ban); all visuals via DS props/primitives.
- Tailwind v4 scans SOURCE TEXT: every class string must be a complete literal (no template interpolation).
- No circles (paper register); pixelarticons only, at native sizes (24px glyph in 48px control for the hamburger — never 22px).
- i18n: all copy through keys in `client-core/src/i18n/locales/en/common.json`; new/changed strings flagged for Miklos's veto pass in the PR/commit message.
- Fluid formulas (exact, everywhere they appear): lockup box `clamp(30px,22px+2.12vw,56px)`; bar vertical padding `clamp(10px,8px+0.5vw,16px)`; horizontal gutter `var(--space-6)` (32px).
- Zero-CLS rule: elevation changes paint only (border COLOR swap on an always-present border; `transform` on the brand slot) — never the bar's layout box.
- TDD: failing test before implementation, every task.
- Implementers run ONLY their own scoped tests (`pnpm --filter <pkg> exec vitest run <file>`); the controller runs full gates + lint + coverage at integration (standing rule).
- Implementers do NOT `git add`/`commit`/`push` — the controller stages and commits serially (standing rule).
- Wave discipline (non-overlapping files): Wave 1 = Tasks 1–6 in parallel; Wave 2 = Tasks 7–8 in parallel; Wave 3 = Task 9; Wave 4 = Task 10 (controller).

---

## File map

| File | Task | Action |
|---|---|---|
| `frontend/client-core/src/contract/menu.ts` | 1 | extend (MenuHeaderRow, MenuEntry) |
| `frontend/ui/src/components/Menu/Menu.tsx` (+`Menu.test.tsx`, `Menu.stories.tsx`) | 1 | extend |
| `frontend/ui/src/styles/semantic.css` | 1 | add `--surface-raised-hover` token (both themes) |
| `frontend/client-core/src/contract/horizontal-lockup.ts` | 2 | extend (`size?: number \| 'fluid'`) |
| `frontend/ui/src/components/HorizontalLockup/HorizontalLockup.tsx` (+tests/story) | 2 | extend |
| `frontend/client-core/src/contract/button.ts` | 3 | extend (`iconTrailing`, `truncate`) |
| `frontend/ui/src/components/Button/Button.tsx` (+tests/story) | 3 | extend |
| `frontend/client-core/src/tokens/scales.ts` | 4 | add `chrome` TYPE_ROLE |
| `frontend/ui/src/lib/typography.ts` (+ Text role plumb-through) | 4 | add `chrome` |
| `frontend/client-core/src/contract/sticky-bar.ts` (new) | 5 | create |
| `frontend/ui/src/components/StickyBar/StickyBar.tsx` (+tests/story) | 5 | create |
| `frontend/src/platform/web/use-scroll-elevation.ts` (+test) | 6 | create |
| `frontend/test/setup.ts` (or the web vitest `setupFiles` target — locate in-task) | 6 | add IntersectionObserver stub |
| `frontend/src/app/paths.ts` (new) | 7 | create (`HOME_PATH`, `BILLING_PATH`, `BUY_ANCHOR`) |
| `frontend/src/app/router.tsx`, `router.test.tsx` | 7 | billing route + settings redirect; move data-free stub |
| `frontend/src/routes/settings.tsx` → `frontend/src/routes/billing.tsx` (+stories rename) | 7 | move/rename |
| `frontend/src/routes/settings/sessions-billing.tsx` → `frontend/src/routes/billing/sessions-billing.tsx` (+test) | 7 | move + `#buy` ref-scroll |
| `frontend/src/routes/billing/checkout-return.tsx`, `checkout-cancelled.tsx` (+tests) | 7 | repoint to `BILLING_PATH`, fix comments |
| `frontend/src/app/header-menu.tsx` (new, +test) | 8 | create |
| `frontend/client-core/src/i18n/locales/en/common.json` | 8 | frame.* key changes |
| `frontend/src/app/app-frame.tsx` (+`app-frame.test.tsx`) | 9 | rewrite header region |
| `frontend/src/app/header-credits.tsx` | 9 | testid scoping only |
| `frontend/src/app/app-frame.stories.tsx` | 10 | new stories, un-exempt a11y |

---

### Task 1: Menu — header rows, width cap, dark-theme highlight

**Files:**
- Modify: `frontend/client-core/src/contract/menu.ts`
- Modify: `frontend/ui/src/components/Menu/Menu.tsx`
- Modify: `frontend/ui/src/styles/semantic.css` (find the block defining `--surface-hover`/`--surface-raised` for `:root` and `.dark`; mirror the existing `@theme` registration pattern used by those tokens)
- Test: `frontend/ui/src/components/Menu/Menu.test.tsx` (extend existing)
- Story: `frontend/ui/src/components/Menu/Menu.stories.tsx` (extend existing; add a dark-theme open story)

**Interfaces:**
- Consumes: nothing new.
- Produces: `MenuHeaderRow { header: true; label: string }`, `MenuEntry = MenuItem | MenuHeaderRow`; `MenuProps.items: readonly MenuEntry[]` (backward compatible — `MenuItem[]` assigns to `MenuEntry[]`). Token `--surface-raised-hover` (light: same value chain `--surface-hover` has in light; dark: `var(--color-paper-600)`), registered so `bg-surface-raised-hover` is a real utility.

- [ ] **Step 1: Write the failing tests** (append to `Menu.test.tsx`, matching its existing render helpers):

```tsx
it('renders a header row as a non-interactive label, not a menuitem (spec: identity header)', async () => {
  const user = userEvent.setup()
  render(
    <Menu
      trigger={<button>open</button>}
      items={[
        { header: true, label: 'Idrisa the Bold' },
        { value: 'logout', label: 'Log out' },
      ]}
      data-testid="menu-content"
    />,
  )
  await user.click(screen.getByText('open'))
  // The header is visible text but NOT a menuitem…
  expect(screen.getByText('Idrisa the Bold')).toBeInTheDocument()
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  // …and is not keyboard-highlightable: ArrowDown from open lands on Log out.
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveAttribute('data-highlighted')
})

it('caps content width and truncates long labels (spec: portal overflow is gate-invisible)', async () => {
  const user = userEvent.setup()
  const long = 'A'.repeat(120)
  render(
    <Menu trigger={<button>open</button>} items={[{ header: true, label: long }]} data-testid="menu-content" />,
  )
  await user.click(screen.getByText('open'))
  const content = screen.getByTestId('menu-content')
  expect(content.className).toContain('max-w-')
  expect(screen.getByText(long).className).toContain('truncate')
})

it('highlights items with the raised-tier hover token (dark-theme visibility fix)', async () => {
  const user = userEvent.setup()
  render(<Menu trigger={<button>open</button>} items={[{ value: 'a', label: 'A' }]} />)
  await user.click(screen.getByText('open'))
  expect(screen.getByRole('menuitem').className).toContain('bg-surface-raised-hover')
  expect(screen.getByRole('menuitem').className).not.toContain('data-[highlighted]:bg-surface-hover')
})
```

- [ ] **Step 2: Run to verify failures**

Run: `cd frontend && pnpm --filter @mythrun/ui exec vitest run src/components/Menu/Menu.test.tsx`
Expected: FAIL — `header: true` rejected by types at build (run with `--typecheck` off it still fails on the role count / class assertions).

- [ ] **Step 3: Extend the contract** (`contract/menu.ts`, below `MenuItem`):

```ts
/**
 * A non-interactive header row (e.g. the identity line atop the mobile frame
 * menu). Rendered as a Radix `DropdownMenu.Label`: visible text, NOT a
 * menuitem — never keyboard-highlighted, never announced as disabled (a
 * `disabled` MenuItem is the WRONG tool for a header: screen readers announce
 * it as dimmed/unavailable).
 */
export interface MenuHeaderRow {
  /** Discriminant. */
  header: true
  /** Row display text — an i18n key the consumer resolves. */
  label: string
}

/** One row of a menu: an actionable item or a non-interactive header. */
export type MenuEntry = MenuItem | MenuHeaderRow
```

and change `items: readonly MenuItem[]` → `items: readonly MenuEntry[]` on `MenuProps` (update the doc line to mention header rows).

- [ ] **Step 4: Extend the impl** (`Menu.tsx`) — replace the `items.map` body and the Content className:

```tsx
        <RadixMenu.Content
          {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
          side={side}
          sideOffset={4}
          className={cn(
            'z-[var(--z-dropdown)] min-w-[10rem] overflow-hidden p-[var(--space-1)]',
            // Width cap (mirrors Popover): a long label must truncate inside the
            // portal, not widen it past the viewport — portalled fixed-position
            // content never shows up in body.scrollWidth, so the CI overflow gate
            // cannot see this class of overflow. Radix exposes the available
            // width as a var; min() it with the same 20rem Popover uses.
            'max-w-[min(20rem,var(--radix-dropdown-menu-content-available-width))]',
            'rounded-none border border-border-strong bg-surface-raised text-ink font-ui',
          )}
        >
          {items.map((entry) =>
            'header' in entry ? (
              <RadixMenu.Label
                key={`header-${entry.label}`}
                className={cn(
                  'flex select-none items-center truncate',
                  'px-[var(--space-3)] py-[var(--space-2)] text-sm font-medium',
                )}
              >
                {entry.label}
              </RadixMenu.Label>
            ) : (
              <RadixMenu.Item
                key={entry.value}
                disabled={entry.disabled ?? false}
                onSelect={() => onSelect?.(entry.value)}
                className={cn(
                  'relative flex cursor-pointer select-none items-center truncate',
                  'px-[var(--space-3)] py-[var(--space-2)] text-sm',
                  // ≥44px rows on touch (matches the Button/IconButton floor).
                  'pointer-coarse:min-h-[44px]',
                  // Raised-tier highlight: --surface-hover equals --surface-raised
                  // in dark theme (both paper-700), which made keyboard focus and
                  // hover INVISIBLE inside the raised popover. The dedicated
                  // raised-tier token keeps one visible step in both themes.
                  'rounded-none outline-none data-[highlighted]:bg-surface-raised-hover',
                  'data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-tertiary',
                )}
              >
                {entry.label}
              </RadixMenu.Item>
            ),
          )}
        </RadixMenu.Content>
```

- [ ] **Step 5: Add the token** in `semantic.css` — next to the existing `--surface-hover` definitions. Light scope: `--surface-raised-hover: <copy the exact light value --surface-hover uses>`; `.dark` scope: `--surface-raised-hover: var(--color-paper-600);` with a comment naming the paper-700 collision. Register it in the same `@theme` block where `--color-surface-hover: var(--surface-hover);`-style lines live, as `--color-surface-raised-hover: var(--surface-raised-hover);`.

- [ ] **Step 6: Run tests** — same command, expected PASS. Then `pnpm --filter @mythrun/ui exec vitest run src/components/Menu` (whole dir) to catch regressions, and `pnpm --filter @mythrun/client-core typecheck && pnpm --filter @mythrun/ui typecheck`.

- [ ] **Step 7: Story** — add to `Menu.stories.tsx`: a `WithHeaderRow` story (header + 2 items, open via play function) and a `DarkOpenHighlight` story (dark theme decorator if the SB theme toolbar isn't scriptable — mirror however existing dark stories do it; if none exist, `parameters: { themes: { themeOverride: 'dark' } }` per the SB theming addon in use — check `.storybook/preview.tsx`). Report done.

### Task 2: HorizontalLockup — fluid mode

**Files:**
- Modify: `frontend/client-core/src/contract/horizontal-lockup.ts`
- Modify: `frontend/ui/src/components/HorizontalLockup/HorizontalLockup.tsx`
- Test: `frontend/ui/src/components/HorizontalLockup/HorizontalLockup.test.tsx` (extend or create beside existing pattern)

**Interfaces:**
- Produces: `size?: number | 'fluid'`. `'fluid'` renders NO width/height attributes; the box is `h-full w-auto` and the parent's height governs. Numeric behavior unchanged (default 56).

- [ ] **Step 1: Failing test:**

```tsx
it("size='fluid' renders no fixed dimensions and fills the parent's height", () => {
  render(<HorizontalLockup aria-label="Mythrun" size="fluid" data-testid="lockup" />)
  const svg = screen.getByTestId('lockup')
  expect(svg).not.toHaveAttribute('width')
  expect(svg).not.toHaveAttribute('height')
  expect(svg.getAttribute('class')).toContain('h-full')
  expect(svg.getAttribute('class')).toContain('w-auto')
})

it('numeric size keeps the locked aspect (regression)', () => {
  render(<HorizontalLockup aria-label="Mythrun" size={56} data-testid="lockup-n" />)
  const svg = screen.getByTestId('lockup-n')
  expect(svg).toHaveAttribute('height', '56')
  expect(Number(svg.getAttribute('width'))).toBeCloseTo((56 * 1284) / 548, 0)
})
```

- [ ] **Step 2: Run — expect FAIL** (type error on `'fluid'` / missing classes).

- [ ] **Step 3: Contract** — change the `size` doc + type:

```ts
  /**
   * Rendered height. A number is CSS pixels with width derived from the locked
   * aspect. `'fluid'` renders no fixed dimensions — the lockup fills its
   * parent's HEIGHT (`h-full w-auto`; the SVG viewBox preserves aspect), for
   * bars whose height is a CSS `clamp()` the number form cannot express.
   * Default `56`.
   */
  size?: number | 'fluid'
```

- [ ] **Step 4: Impl** — in the component:

```tsx
  const fluid = size === 'fluid'
  const width = fluid ? undefined : (size * ASPECT_W) / ASPECT_H
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${String(ASPECT_W)} ${String(ASPECT_H)}`}
      {...(fluid ? {} : { width, height: size })}
      fill="currentColor"
      role="img"
      aria-label={ariaLabel}
      className={cn('shrink-0 text-ink', fluid && 'h-full w-auto')}
```

(keep the rest; note `size = 56` default destructure means the `fluid` check must come before any arithmetic — TS will narrow `size` to `number` after the `fluid` ternary).

- [ ] **Step 5: Run tests (pass), typecheck both packages, add a `Fluid` story** rendering the lockup inside a `<div style>`-free DS Box… stories MAY use plain divs — wrap in `<div className="h-12">`. Report done.

### Task 3: Button — trailing icon + single-line truncation

**Files:**
- Modify: `frontend/client-core/src/contract/button.ts`
- Modify: `frontend/ui/src/components/Button/Button.tsx`
- Test: `frontend/ui/src/components/Button/Button.test.tsx` (extend)

**Interfaces:**
- Produces: `iconTrailing?: ReactNode` (mirror of `icon`, rendered AFTER the label, same gap); `truncate?: boolean` — label renders single-line ellipsis capped at `max-w-[16rem]` (the menu-trigger cap; unbounded display names are the one consumer).

- [ ] **Step 1: Failing tests:**

```tsx
it('renders a trailing icon after the label', () => {
  render(<Button iconTrailing={<span data-testid="chev" />}>Name</Button>)
  const button = screen.getByRole('button')
  const chev = screen.getByTestId('chev')
  // Trailing: the icon is the LAST element child.
  expect(button.lastElementChild).toContainElement(chev)
})

it('truncate renders a single-line capped label', () => {
  render(<Button truncate>{'A'.repeat(120)}</Button>)
  const label = screen.getByText('A'.repeat(120))
  expect(label.className).toContain('truncate')
  expect(label.className).toContain('max-w-[16rem]')
})
```

- [ ] **Step 2: Run — expect FAIL** (unknown props).

- [ ] **Step 3: Contract** (below `icon`):

```ts
  /**
   * Trailing-icon slot — the mirror of `icon`, rendered AFTER the label with
   * the same gap. For triggers whose affordance follows the label (the header
   * menu's chevron). Decorative; the label carries the meaning.
   */
  iconTrailing?: ReactNode
  /**
   * Single-line label: no wrap, ellipsis, capped at 16rem. For labels made of
   * unbounded user data (the header menu trigger is the display name — the
   * default grow-taller wrapping would fold the bar). Off by default.
   */
  truncate?: boolean
```

- [ ] **Step 4: Impl** — in `Button.tsx`, find where `icon` and the label render (the children span). Wrap the label in a span that takes `truncate && 'truncate max-w-[16rem] whitespace-nowrap'` (complete literal in a `cn()` conditional), and render `{iconTrailing != null && <span aria-hidden="true">{iconTrailing}</span>}` after it, symmetric with the leading slot's markup. Destructure both new props.

- [ ] **Step 5: Run task tests + the whole Button suite** (`pnpm --filter @mythrun/ui exec vitest run src/components/Button`) — the suite pins button markup in several places; fix ONLY breakages your change caused (the label-wrapping span may shift `textContent` assertions — they should still pass; if an assertion inspects `children` positions, update it to match the new, still-correct DOM). Typecheck both packages. Report done.

### Task 4: `chrome` type role

**Files:**
- Modify: `frontend/client-core/src/tokens/scales.ts` (find `TYPE_ROLES` — the data source of truth; add `chrome` following the exact shape of the `data` entry, but with `tracking: 0.01em`-equivalent field the structure uses; read neighboring entries first)
- Modify: `frontend/ui/src/lib/typography.ts`
- Test: whatever tests pin `TYPE_ROLE_CLASS`/`TYPE_ROLES` completeness (grep `TYPE_ROLE` in both packages' tests; extend the pinned lists)

**Interfaces:**
- Produces: `TypeRole` union gains `'chrome'`; `TYPE_ROLE_CLASS.chrome = 'font-ui text-sm font-normal tracking-[0.01em]'`. `Text role="chrome"` works wherever `Text` accepts roles (the role type flows from this union).

- [ ] **Step 1:** Extend the pinned test lists (failing) — add `'chrome'` AND `'chrome-strong'` to whatever completeness test enumerates roles, plus:

```tsx
it('chrome: 14px mono, hairline tracking, no color facet (bar chrome)', () => {
  expect(TYPE_ROLE_CLASS.chrome).toBe('font-ui text-sm font-normal tracking-[0.01em]')
})

it('chrome-strong: the credit number — semibold, tabular, the bar\'s ONE accent', () => {
  expect(TYPE_ROLE_CLASS['chrome-strong']).toBe(
    'font-ui text-sm font-semibold tracking-[0.01em] tabular-nums text-accent-fg',
  )
})
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3:** Add BOTH to `TypeRole` union + `TYPE_ROLE_CLASS` (comment: "chrome / chrome-strong — the frame's one utility size (spec 2026-07-30): 14px mono, 0.01em tracking. `chrome` stays weight/color-ambient; `chrome-strong` is the credit NUMBER — semibold + tabular-nums + accent-fg, the bar's ONLY accent, so 'accent' keeps meaning 'the number that is yours'"). Add matching `TYPE_ROLES` entries in `client-core/src/tokens/scales.ts` mirroring `data`'s shape with the tracking/weight/numeric facets.
- [ ] **Step 4: Run tests (pass); typecheck both packages.** Report done.

### Task 5: StickyBar — the scroll-visual primitive

**Files:**
- Create: `frontend/client-core/src/contract/sticky-bar.ts` (+ export from `contract/index.ts` — mirror how `menu.ts` is exported)
- Create: `frontend/ui/src/components/StickyBar/StickyBar.tsx` (+ export from the ui package index, mirroring Menu)
- Test: `frontend/ui/src/components/StickyBar/StickyBar.test.tsx`
- Story: `frontend/ui/src/components/StickyBar/StickyBar.stories.tsx`

**Interfaces:**
- Consumes: Task 2's `size="fluid"` lockup goes in the `brand` slot (by the consumer).
- Produces:

```ts
import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/**
 * The app's sticky top bar — owns EVERY scroll-visual mechanic so app code
 * never needs a className (spec 2026-07-30 §Scroll mechanics, normative):
 *
 *  • `position: sticky; top: 0`, one layer above content, below the Menu
 *    portal's --z-dropdown.
 *  • Fluid metrics: brand-slot height `clamp(30px, 22px + 2.12vw, 56px)`,
 *    vertical padding `clamp(10px, 8px + 0.5vw, 16px)`, horizontal gutter
 *    --space-6 (32px) matching the content Box.
 *  • ZERO-CLS elevation: the layout box NEVER changes. `elevated` swaps the
 *    always-present bottom border transparent → --border, and transform-scales
 *    the brand slot to 0.82 (origin left-center) from `sm` up. Transitions
 *    honor prefers-reduced-motion (states still swap; motion is removed).
 *
 * `brand` is the left slot (lockup-in-link); `children` is the right cluster.
 */
export interface StickyBarProps extends BaseProps {
  /** Elevated (content has scrolled beneath): hairline on, brand compacted. */
  elevated: boolean
  /** Left slot — the brand lockup (wrapped in its home link). */
  brand: ReactNode
}
```

- [ ] **Step 1: Failing tests:**

```tsx
import { render, screen } from '@testing-library/react'
import { StickyBar } from './StickyBar.tsx'

function bar(elevated: boolean) {
  render(
    <StickyBar elevated={elevated} brand={<span data-testid="brand-slot-child" />} data-testid="bar">
      <span>right</span>
    </StickyBar>,
  )
  return screen.getByTestId('bar')
}

it('is sticky, layered, and gutter-aligned', () => {
  const el = bar(false)
  expect(el.className).toContain('sticky')
  expect(el.className).toContain('top-0')
  expect(el.className).toContain('px-[var(--space-6)]')
})

it('at rest: transparent border present (zero-CLS reservation), no compaction', () => {
  const el = bar(false)
  expect(el.className).toContain('border-b')
  expect(el.className).toContain('border-transparent')
  expect(el.querySelector('[data-brand-slot]')?.className).not.toContain('scale-')
})

it('elevated: border colors in, brand slot compacts, box classes unchanged', () => {
  const el = bar(true)
  expect(el.className).toContain('border-border')
  expect(el.className).not.toContain('border-transparent')
  const brand = el.querySelector('[data-brand-slot]')
  expect(brand?.className).toContain('sm:scale-[0.82]')
  expect(brand?.className).toContain('origin-left')
  // The brand slot's HEIGHT class is identical in both states (paint-only rule).
  expect(brand?.className).toContain('h-[clamp(30px,22px+2.12vw,56px)]')
})
```

- [ ] **Step 2: Run — FAIL (module doesn't exist).**

- [ ] **Step 3: Implement** `StickyBar.tsx`:

```tsx
import { forwardRef } from 'react'
import type { StickyBarProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// StickyBar — the frame's top bar; owns all scroll-visual mechanics (spec
// 2026-07-30 §Scroll mechanics). Zero-CLS: `elevated` changes PAINT only —
// border color + brand transform — never the layout box. The border is
// always-mounted (transparent at rest) so the hairline's arrival shifts
// nothing; compaction is a transform on the brand slot, so the document
// doesn't reflow mid-scroll. Transitions are removed (not the state change)
// under prefers-reduced-motion via motion-reduce.
export const StickyBar = forwardRef<HTMLElement, StickyBarProps>(function StickyBar(
  { elevated, brand, children, 'data-testid': dataTestId },
  ref,
) {
  return (
    <header
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn(
        'sticky top-0 z-[100] bg-bg',
        'flex items-center justify-between gap-[var(--space-4)]',
        'px-[var(--space-6)] py-[clamp(10px,8px+0.5vw,16px)]',
        'border-b transition-colors motion-reduce:transition-none',
        elevated ? 'border-border' : 'border-transparent',
      )}
    >
      <div
        data-brand-slot
        className={cn(
          'h-[clamp(30px,22px+2.12vw,56px)] shrink-0',
          'origin-left transition-transform motion-reduce:transition-none',
          elevated && 'sm:scale-[0.82]',
        )}
      >
        {brand}
      </div>
      {children}
    </header>
  )
})
```

Check `--z-sticky` exists in `theme.css`; if not, `z-[100]` stays (comment: below `--z-dropdown` 1000).

- [ ] **Step 4: Run tests (pass); typecheck; export from both package indexes; story** with a tall scroll container demonstrating rest/elevated via the prop (no observer here — StickyBar is dumb). Report done.

### Task 6: `useScrollElevation` + IntersectionObserver test stub

**Files:**
- Create: `frontend/src/platform/web/use-scroll-elevation.ts`
- Test: `frontend/src/platform/web/use-scroll-elevation.test.ts`
- Modify: the web vitest setup file — find via `frontend/vitest.config.ts` `setupFiles`; add the IO stub THERE (it must load for every web suite: Task 9's AppFrame mounts the hook everywhere).

**Interfaces:**
- Produces:

```ts
export interface ScrollElevation {
  /** True once the sentinel has left the viewport (content scrolled beneath the bar). */
  readonly elevated: boolean
  /** Attach to a 1px absolutely-positioned sentinel at the TOP of the document. */
  readonly sentinelRef: (node: HTMLElement | null) => void
}
export function useScrollElevation(forceElevated?: boolean): ScrollElevation
```

- [ ] **Step 1: IO stub** in the web setup file (before the failing test, or nothing mounts):

```ts
// jsdom has no IntersectionObserver. Minimal stub: constructible, records
// instances so tests can drive callbacks; observe/disconnect are spies.
class IntersectionObserverStub implements IntersectionObserver {
  static instances: IntersectionObserverStub[] = []
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: readonly number[] = []
  constructor(public callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  takeRecords = (): IntersectionObserverEntry[] => []
}
vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
```

Export the class from a small helper module beside the setup file so tests can import it for callback-driving (`frontend/test/intersection-observer-stub.ts`; setup imports and stubs).

- [ ] **Step 2: Failing hook tests:**

```tsx
import { renderHook, act } from '@testing-library/react'
import { IntersectionObserverStub } from '../../../test/intersection-observer-stub.ts'
import { useScrollElevation } from './use-scroll-elevation.ts'

function drive(intersecting: boolean) {
  const io = IntersectionObserverStub.instances.at(-1)
  act(() => {
    io?.callback([{ isIntersecting: intersecting } as IntersectionObserverEntry], io)
  })
}

it('not elevated while the sentinel intersects; elevated once it leaves', () => {
  const { result } = renderHook(() => useScrollElevation())
  act(() => result.current.sentinelRef(document.createElement('div')))
  drive(true)
  expect(result.current.elevated).toBe(false)
  drive(false)
  expect(result.current.elevated).toBe(true)
})

it('forceElevated wins regardless of observation', () => {
  const { result } = renderHook(() => useScrollElevation(true))
  expect(result.current.elevated).toBe(true)
})

it('disconnects on unmount and on ref detach', () => {
  const { result, unmount } = renderHook(() => useScrollElevation())
  act(() => result.current.sentinelRef(document.createElement('div')))
  const io = IntersectionObserverStub.instances.at(-1)
  unmount()
  expect(io?.disconnect).toHaveBeenCalled()
})
```

- [ ] **Step 3: Run — FAIL. Step 4: Implement:**

```ts
import { useCallback, useRef, useState } from 'react'

// The elevation signal for the sticky frame bar (spec 2026-07-30 §Scroll
// mechanics, normative). The sentinel MUST sit at the TOP of the scrolled
// document, absolutely positioned (occupying no flow space): a sentinel BELOW
// a sticky bar slides under it and IntersectionObserver does not model
// occlusion — it would fire a full bar-height (~88px) late. Top-of-document
// placement fires within ~1px of scroll and is decoupled from the fluid bar
// height. Lives in platform/web, NOT client-core: IntersectionObserver is a
// web API and client-core stays platform-neutral.
//
// `forceElevated` pins the state for stories/tests (the Storybook elevated
// story cannot scroll deterministically under the CI gate's double-resize).
export function useScrollElevation(forceElevated?: boolean): ScrollElevation {
  const [elevated, setElevated] = useState(false)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const sentinelRef = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (node === null) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry !== undefined) setElevated(!entry.isIntersecting)
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])
  return { elevated: forceElevated ?? elevated, sentinelRef }
}
```

(plus the `ScrollElevation` interface above it; unmount disconnect: the callback-ref receives `null` on unmount in React 19 — the `node === null` arm covers both. Verify the test passes; if React's cleanup ordering differs, add a `useEffect` cleanup that disconnects.)

- [ ] **Step 5: Run tests (pass); typecheck web.** Report done.

### Task 7: Routes — `/billing`, redirect, `#buy` scroll, consumers

**Files:**
- Create: `frontend/src/app/paths.ts`
- Modify: `frontend/src/app/router.tsx` + `frontend/src/app/router.test.tsx` (data-free stub at :172-178 moves to `/billing/cancelled`)
- Move: `frontend/src/routes/settings.tsx` → `frontend/src/routes/billing.tsx`; `frontend/src/routes/settings.stories.tsx` → `frontend/src/routes/billing.stories.tsx` (title `Screens/Billing`); `frontend/src/routes/settings/sessions-billing.tsx` + test → `frontend/src/routes/billing/`
- Modify: `frontend/src/routes/billing/checkout-return.tsx` (:16-19 comment, :19 path), `checkout-cancelled.tsx` (:7 comment, :10 path), their tests (stubs pin `/settings`)
- Test: extend `frontend/src/routes/billing/sessions-billing.test.tsx` with the `#buy` scroll test; new redirect test in `router.test.tsx`

**Interfaces:**
- Produces: `paths.ts`:

```ts
// Shared route constants for the frame + billing surfaces. Module consts so
// paths are never JSX-attribute string literals (the i18n rule) and never
// drift across their three consumers (app-frame, checkout-return,
// checkout-cancelled — the 2026-07-30 spec's enumerated /settings callers).
export const HOME_PATH = '/home'
export const BILLING_PATH = '/billing'
export const BUY_ANCHOR = '#buy'
```

- Produces: `sessions-billing.tsx` exports unchanged; internally the purchase section root gains `ref={buySectionRef}` + `scroll-mt-24` via… the section is composed of DS components — wrap the purchase block in the route file's own plain `<section ref={buySectionRef} className="scroll-mt-24">` (route files are app code but plain HTML elements in app code carry no BaseProps ban; ONLY DS components do — mirror how app-frame uses no raw classes on DS pieces but the route already uses plain wrappers if any exist; if the file is 100% DS-composed, add the plain `<section>` wrapper — a structural, non-visual element).

- [ ] **Step 1: Failing tests.** Redirect (in `router.test.tsx`, mirroring its existing render-at-path helper):

```tsx
it('legacy /settings redirects to /billing preserving search and hash (replace)', async () => {
  renderAt('/settings?tab=history#buy')
  await waitFor(() => {
    expect(screen.getByTestId('billing-screen')).toBeInTheDocument()
  })
  expect(window.location.pathname).toBe('/billing')
  expect(window.location.search).toBe('?tab=history')
  expect(window.location.hash).toBe('#buy')
})
```

`#buy` scroll (in `sessions-billing.test.tsx`, using its existing mocked-queries harness):

```tsx
it('arriving with #buy scrolls the purchase section into view after data resolves', async () => {
  const scrollSpy = vi.fn()
  window.HTMLElement.prototype.scrollIntoView = scrollSpy
  renderBillingAt('/billing#buy')
  await screen.findByTestId('billing-buy-section')
  await waitFor(() => {
    expect(scrollSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement.** Router: rename the route entry to `{ path: 'billing', element: <BillingRoute /> }`; add:

```tsx
// Legacy path: /settings was the billing page's original home (MYT-99 interim).
// Client-side 301: replace semantics (Back must not bounce), search + hash
// preserved. Lives inside the authed AppFrame branch: an anon deep link hits
// the auth gate FIRST, then redirects.
function LegacySettingsRedirect(): React.JSX.Element {
  const { search, hash } = useLocation()
  return <Navigate to={`${BILLING_PATH}${search}${hash}`} replace />
}
```

with route `{ path: 'settings', element: <LegacySettingsRedirect /> }`. Move files; update imports; checkout routes import `BILLING_PATH` from `paths.ts` and their comments describe the new IA. `sessions-billing.tsx`: add `const buySectionRef = useRef<HTMLElement | null>(null)`; wrap the purchase block in `<section ref={buySectionRef} data-testid="billing-buy-section" className="scroll-mt-24">`; effect:

```tsx
  const { hash } = useLocation()
  // #buy deep-link (spec §Scroll mechanics): React Router doesn't fragment-
  // scroll, and this section mounts inside a Suspense boundary, so a DOM id
  // anchor works in NO navigation mode. Scroll once the data-resolved section
  // exists; scroll-mt clears the sticky bar (96px ≥ the 88px max bar height).
  useEffect(() => {
    if (hash === BUY_ANCHOR) buySectionRef.current?.scrollIntoView()
  }, [hash])
```

(this component renders below the Suspense boundary, so mount ≡ data resolved). Move `router.test.tsx`'s data-free stub from `/settings` to `/billing/cancelled` (it was chosen for mounting no queries; `/billing/cancelled` shares the property).

- [ ] **Step 4: Run the touched suites** (`router.test.tsx`, `sessions-billing.test.tsx`, `checkout-return.test.tsx`, `checkout-cancelled.test.tsx`, `billing.stories` via screen-story pairing) + web typecheck. Report done, listing every renamed file for the controller's wiki note.

### Task 8: HeaderMenu + logout + i18n keys

**Files:**
- Create: `frontend/src/app/header-menu.tsx`
- Test: `frontend/src/app/header-menu.test.tsx`
- Modify: `frontend/client-core/src/i18n/locales/en/common.json` (the `frame` block)

**Interfaces:**
- Consumes: Task 1 `MenuEntry`/header rows; Task 3 `iconTrailing`/`truncate`; Task 7 `BILLING_PATH`, `BUY_ANCHOR`; client-core `logout` (mirror the ctx-passing pattern of the nearest existing caller of `refreshSession`/`createSession` — grep it in-task); the existing Toast error surface (grep how routes surface errors — `useToast` or equivalent).
- Produces:

```tsx
export interface HeaderMenuProps {
  /** 'desktop': name-as-trigger, [Sessions & billing, Log out].
   *  'mobile': hamburger trigger, [identity header?, Campaigns, Add credits, Sessions & billing, Log out]. */
  arrangement: 'desktop' | 'mobile'
  /** Resolved display name; null while loading or failed → icon trigger + no header row. */
  displayName: string | null
}
export function HeaderMenu(props: HeaderMenuProps): React.JSX.Element
```

- i18n `frame` block becomes exactly:

```json
"frame": {
  "buyCredits": "Add credits",
  "campaigns": "Campaigns",
  "credits": "Credits",
  "creditsLoading": "Loading balance",
  "logout": "Log out",
  "menu": "Menu",
  "sessionsBilling": "Sessions & billing",
  "wordmark": "Mythrun"
}
```

(`credits` value CHANGES "Session credits"→"Credits" — approved mocks; `settings` REMOVED — grep for `frame.settings` consumers and remove with the gear; additions flagged for the copy veto.)

- [ ] **Step 1: Failing tests** (harness: mirror `app-frame.test.tsx`'s router+query wrapper):

```tsx
it('desktop: the display name IS the accessible trigger name; menu lists exactly billing + logout', async () => {
  const user = userEvent.setup()
  renderHeaderMenu({ arrangement: 'desktop', displayName: 'Idrisa the Bold' })
  const trigger = screen.getByRole('button', { name: 'Idrisa the Bold' })
  expect(trigger).not.toHaveAttribute('aria-label') // visible name = accessible name
  await user.click(trigger)
  const items = screen.getAllByRole('menuitem')
  expect(items.map((i) => i.textContent)).toEqual(['Sessions & billing', 'Log out'])
})

it('desktop with NULL identity (loading or failed): falls back to the icon trigger — menu never unreachable', () => {
  renderHeaderMenu({ arrangement: 'desktop', displayName: null })
  expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument()
})

it('mobile: full list with identity header row; header is not a menuitem', async () => {
  const user = userEvent.setup()
  renderHeaderMenu({ arrangement: 'mobile', displayName: 'Idrisa the Bold' })
  await user.click(screen.getByRole('button', { name: 'Menu' }))
  expect(screen.getByText('Idrisa the Bold')).toBeInTheDocument()
  expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
    'Campaigns',
    'Add credits',
    'Sessions & billing',
    'Log out',
  ])
})

it('logout success: calls the endpoint then hard-navigates to /', async () => {
  const user = userEvent.setup()
  logoutMock.mockResolvedValueOnce(undefined)
  renderHeaderMenu({ arrangement: 'desktop', displayName: 'X' })
  await user.click(screen.getByRole('button', { name: 'X' }))
  await user.click(screen.getByRole('menuitem', { name: 'Log out' }))
  await waitFor(() => expect(logoutMock).toHaveBeenCalled())
  expect(hardNavigateMock).toHaveBeenCalledWith('/')
})

it('logout FAILURE: toast, NO navigation (a live refresh cookie + navigate would resurrect the session)', async () => {
  const user = userEvent.setup()
  logoutMock.mockRejectedValueOnce(new Error('503'))
  renderHeaderMenu({ arrangement: 'desktop', displayName: 'X' })
  await user.click(screen.getByRole('button', { name: 'X' }))
  await user.click(screen.getByRole('menuitem', { name: 'Log out' }))
  await waitFor(() => expect(toastSpy).toHaveBeenCalled())
  expect(hardNavigateMock).not.toHaveBeenCalled()
})
```

(mock `logout` at the client-core import boundary and hard-navigation at `platform/web/navigation` — grep its exported name and mirror existing test mocks of it.)

Plus the arrangement-change close (spec, normative — `Show` hides via `display:none`, so BOTH HeaderMenu instances stay MOUNTED; an open mobile menu's PORTAL would survive a resize across the breakpoint, floating over the desktop arrangement):

```tsx
it('an open menu closes when the viewport crosses the arrangement breakpoint', async () => {
  const user = userEvent.setup()
  renderHeaderMenu({ arrangement: 'mobile', displayName: 'X' })
  await user.click(screen.getByRole('button', { name: 'Menu' }))
  expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0)
  act(() => {
    matchMediaStub.dispatchChange() // drive the stubbed matchMedia listener
  })
  await waitFor(() => {
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  })
})
```

(jsdom has no real `matchMedia` — grep the web test setup for an existing stub; if none, add a minimal one beside the IO stub exposing `dispatchChange()`.)

- [ ] **Step 2: Run — FAIL. Step 3: Implement** `header-menu.tsx`:

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, IconButton, Icon, Menu } from '@mythrun/ui'
import type { MenuEntry } from '@mythrun/client-core/contract'
import { BILLING_PATH, BUY_ANCHOR, HOME_PATH } from './paths.ts'
// logout + ctx + hard-navigate + toast imports: mirror the repo's existing
// patterns (grep refreshSession's caller for ctx; navigation.ts for the
// hard-navigate helper; the standing toast surface for errors).

const BILLING_VALUE = 'billing'
const LOGOUT_VALUE = 'logout'
const CAMPAIGNS_VALUE = 'campaigns'
const BUY_VALUE = 'buy'

// One parameterized menu so the two arrangements cannot drift (spec
// §Architecture). Desktop: name-as-trigger (the VISIBLE name is the
// accessible name — no aria-label override; voice-control users say what they
// see), trailing chevron. Mobile: labeled icon trigger, full list, identity
// as a HEADER row (never a disabled item). displayName null (loading OR
// failed): icon trigger both arms — a null pending fallback would leave Log
// out unreachable during every cold /me fetch.
export function HeaderMenu({ arrangement, displayName }: HeaderMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  const items: MenuEntry[] =
    arrangement === 'mobile'
      ? [
          ...(displayName !== null ? [{ header: true as const, label: displayName }] : []),
          { value: CAMPAIGNS_VALUE, label: t('frame.campaigns') },
          { value: BUY_VALUE, label: t('frame.buyCredits') },
          { value: BILLING_VALUE, label: t('frame.sessionsBilling') },
          { value: LOGOUT_VALUE, label: t('frame.logout'), disabled: busy },
        ]
      : [
          { value: BILLING_VALUE, label: t('frame.sessionsBilling') },
          { value: LOGOUT_VALUE, label: t('frame.logout'), disabled: busy },
        ]

  const onSelect = (value: string): void => {
    if (value === CAMPAIGNS_VALUE) void navigate(HOME_PATH)
    if (value === BUY_VALUE) void navigate(`${BILLING_PATH}${BUY_ANCHOR}`)
    if (value === BILLING_VALUE) void navigate(BILLING_PATH)
    if (value === LOGOUT_VALUE) void runLogout()
  }

  const runLogout = async (): Promise<void> => {
    setBusy(true)
    try {
      await logout(ctx) // exact call shape per the repo's endpoint pattern
      hardNavigate('/') // module token + QueryClient die with the document
    } catch {
      showErrorToast(t('frame.logoutFailed')) // navigating on failure would
      setBusy(false) // resurrect the session via the landing's refresh probe
    }
  }

  const trigger =
    arrangement === 'desktop' && displayName !== null ? (
      <Button variant="ghost" size="md" truncate iconTrailing={<Icon name="chevron-down" size="sm" />} data-testid="frame-menu-trigger">
        {displayName}
      </Button>
    ) : (
      <IconButton icon="menu" label={t('frame.menu')} variant="ghost" size="lg" data-testid="frame-menu-trigger" />
    )

  // Controlled open + arrangement-change close: Show CSS-hides (display:none)
  // rather than unmounts, so this instance survives a breakpoint cross while
  // its PORTAL (portalled to body — not display:none'd) would stay open,
  // floating over the other arrangement. Close on every crossing of the sm
  // breakpoint (spec §Architecture, normative).
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)') // Tailwind sm — verify against the theme
    const close = (): void => setOpen(false)
    mq.addEventListener('change', close)
    return () => mq.removeEventListener('change', close)
  }, [])

  return (
    <Menu trigger={trigger} items={items} onSelect={onSelect} open={open} onOpenChange={setOpen} data-testid="frame-menu" />
  )
}
```

(NOTE for implementer: `frame.logoutFailed` = "Couldn't log out. Try again." — add to the i18n block, flag for veto. Icon `size` prop: use the DS's size tokens — `sm` = 16px beside 14px text; verify against `contract/icon.ts` names.)

- [ ] **Step 4:** Update the i18n block per Interfaces; grep `frame.settings` (dies with the gear — its one consumer is app-frame's gear, removed in Task 9; if Task 9 hasn't landed, leave the key and note it for Task 9's diff — key removal belongs to whichever task deletes the last consumer; coordinate via report).
- [ ] **Step 5: Run suite (pass); web typecheck.** Report done.

### Task 9: AppFrame rewrite

**Files:**
- Modify: `frontend/src/app/app-frame.tsx` (header region — the content-region/fullBleed logic at the bottom is UNCHANGED)
- Modify: `frontend/src/app/app-frame.test.tsx` (arrangement-scoped testids; new assertions)
- Modify: `frontend/src/app/header-credits.tsx` — (a) accept a `data-testid` passthrough so the two mounted instances are distinguishable (`frame-credits-desktop` / `frame-credits-mobile`); (b) typography per spec: label `<Text role="chrome">` (was `meta`), number `<Text role="chrome-strong">` (was `data`) — the number is semibold tabular accent, the bar's ONLY accent (Task 4's roles)

**Interfaces:**
- Consumes: everything from Tasks 1–8. Exact composition (`forceElevated` is the story/test plumb Task 10's `Elevated` story uses — document it "stories/tests only"):

```tsx
export function AppFrame({ forceElevated }: { forceElevated?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation()
  const fullBleed = useMatches().some((match) => hasFullBleedHandle(match.handle))
  const { elevated, sentinelRef } = useScrollElevation(forceElevated)
  const displayName = useHeaderDisplayName() // extract from HeaderIdentity's data path:
  // a small hook returning string | null (null while loading OR on error) —
  // implementer: read header-identity.tsx's useMe usage and lift the value; keep
  // HeaderIdentity itself for its boundary behavior OR replace with the hook +
  // HeaderMenu (the spec moves identity INTO the menu; the standalone
  // <HeaderIdentity/> row leaves the bar on desktop — the name now lives on the
  // menu trigger).
  return (
    <Stack minHeight="screen" data-testid="app-frame">
      {/* 1px elevation sentinel — TOP of the document, absolute, no flow space
          (spec: a sentinel BELOW a sticky bar fires a bar-height late). Plain
          element in app code, fine: the BaseProps ban covers DS components. */}
      <div ref={sentinelRef} aria-hidden="true" className="absolute top-0 h-px w-px" data-testid="frame-sentinel" />
      <StickyBar
        elevated={fullBleed ? false : elevated}
        data-testid="app-frame-header"
        brand={
          <Link href={HOME_PATH} unstyled data-testid="frame-logo-link">
            <HorizontalLockup aria-label={t('frame.wordmark')} size="fluid" data-testid="frame-logo" />
          </Link>
        }
      >
        {/* Desktop cluster (sm+): credits · Add credits · name-menu */}
        <Show above="sm">
          <Stack direction="row" align="center" gap={5}>
            <HeaderCredits data-testid="frame-credits-desktop" />
            {!fullBleed && (
              <Button variant="ghost" size="md" onPress={goToBuy} data-testid="frame-buy-credits">
                {t('frame.buyCredits')}
              </Button>
            )}
            <HeaderMenu arrangement="desktop" displayName={displayName} />
          </Stack>
        </Show>
        {/* Mobile cluster (below sm): credits · hamburger-menu */}
        <Show below="sm">
          <Stack direction="row" align="center" gap={4}>
            <HeaderCredits data-testid="frame-credits-mobile" />
            <HeaderMenu arrangement="mobile" displayName={displayName} />
          </Stack>
        </Show>
      </StickyBar>
      {/* NO standalone <Divider/> — the hairline is StickyBar's border swap. */}
      …content region unchanged…
```

`goToBuy = () => void navigate(`${BILLING_PATH}${BUY_ANCHOR}`)`. Gear IconButton, `SETTINGS_PATH`, `goToSettings`, and the old `<Divider/>` all DELETED (with `frame.settings` from the i18n block — coordinate with Task 8's note). `Show below` — verify the Show contract's prop name for the under-side (`below="sm"` vs `under`); mirror its existing usage.

- [ ] **Step 1: Failing tests** (rewrite the affected `app-frame.test.tsx` cases):

```tsx
it('renders no gear and no standalone divider (the hairline is the bar border)', () => {
  renderFrame()
  expect(screen.queryByTestId('frame-settings')).toBeNull()
  expect(screen.queryByTestId('app-frame-divider')).toBeNull()
})

it('desktop cluster: credits, Add credits → /billing#buy, name-menu', async () => {
  const user = userEvent.setup()
  renderFrame()
  expect(screen.getByTestId('frame-credits-desktop')).toBeInTheDocument()
  await user.click(screen.getByTestId('frame-buy-credits'))
  expect(currentLocation().pathname + currentLocation().hash).toBe('/billing#buy')
})

it('fullBleed: buy button stands down; the menu does not; bar never elevates', () => {
  renderFrameAt(FULL_BLEED_ROUTE)
  expect(screen.queryByTestId('frame-buy-credits')).toBeNull()
  expect(screen.getByTestId('frame-menu-trigger')).toBeInTheDocument()
  expect(screen.getByTestId('app-frame-header').className).toContain('border-transparent')
})

it('lockup is fluid inside the bar brand slot', () => {
  renderFrame()
  const svg = screen.getByTestId('frame-logo')
  expect(svg).not.toHaveAttribute('width')
})
```

(keep/adapt the existing suite's remaining cases; the sentinel + elevation state transitions are covered by Task 6's hook tests — here assert only the wiring: driving the stub observer flips the bar's border class.)

- [ ] **Step 2: Run — FAIL. Step 3: Implement** per the composition above. **Step 4: Run the full `app-frame.test.tsx` + `router.test.tsx` + `header-credits` suites; web typecheck.** Report done with any deviations.

### Task 10 (controller): stories, gates, visual audit

- [ ] **Step 1: Stories** — rewrite `app-frame.stories.tsx`: `Rest`, `Elevated` (a story-level wrapper passing `forceElevated` — add a story-only prop plumb: `AppFrame` accepts `forceElevated?: boolean` forwarded to the hook, documented "stories/tests only"), `Mobile` (375 viewport param), `MobileMenuOpen` + `DesktopMenuOpen` (play functions, BOTH themes — the dark story exercises the Task 1 highlight fix), `FullBleed`, `AdversarialName` (70-char name, mid viewport param 768), `AdversarialBalance` (5-digit balance at 375 — extend the harness seed). REMOVE `a11y: {test:'off'}`.
- [ ] **Step 2: Full gates** — `pnpm --filter @mythrun/client-core typecheck && lint && test`, same for ui and web, `pnpm --filter @mythrun/web build-storybook && test-storybook:ci` (the 375 overflow + a11y sweep — dark menu-open must pass), `pnpm --filter @mythrun/web build`.
- [ ] **Step 3: Wiki sync** — pages pinning `/settings` (`frontend/billing-credits.html`, `campaign-hub.html`) + `frontend/design-system.html` (Menu/StickyBar/Button/lockup changes) + `frontend/app-shell.html` (the frame rewrite) via the standing protocol.
- [ ] **Step 4: STOP — visual audit.** Local `pnpm dev`, Miklos reviews desktop + 375 + dark + scroll behavior BEFORE any push (standing rule). Fix what he flags; only then commit-finalize and push.

## Execution waves (for subagent-driven-development)

- **Wave 1 (parallel, disjoint):** Tasks 1, 2, 3, 4, 5, 6
- **Wave 2 (parallel, disjoint):** Tasks 7, 8
- **Wave 3:** Task 9 (consumes everything)
- **Wave 4:** Task 10 (controller only)
- Controller commits serially after reviewing each task's diff; implementers never git.
