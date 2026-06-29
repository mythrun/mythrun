# MYT-86 Public Landing Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public landing page — a responsive minimal nav, a clean hero, a transparent pricing line, a dither→inverted-footer — composed entirely from `@mythrun/ui`, routing visitors to `/auth/signin`.

**Architecture:** Replace the `landing.tsx` stub with a route-local composition (`LandingNav` / `LandingHero` / `LandingFooter`) under a `Stack minHeight="screen"` root. Two small `@mythrun/ui` additions unblock it: a `placement` mode on `ThemeToggle` (FAB → inline) and semantic-landmark support on `Box` (`as: nav|main|footer|…`). All prose is `[ph_]` i18n placeholders; only generic chrome ("Sign in", the lockup label) gets real values. The dark-CTA WCAG-AA fix already shipped at the token level (commit `b251053`); the landing just consumes `--accent` (button fill) and `--accent-fg` (links/focus).

**Tech Stack:** React 19 + TypeScript (strict) + react-router-dom v7 + react-i18next + Vitest + `@testing-library/react` + jest-axe + Storybook (`@storybook/react-vite`). Packages: `@mythrun/ui` (design system), `@mythrun/web` (`frontend/` — routes, i18n runtime, stories), `@mythrun/client-core` (contracts + i18n catalog).

## Global Constraints

Every task's requirements implicitly include this section. Values are verbatim from the spec + the codebase.

- **No ad-hoc UI.** All UI from `@mythrun/ui`. In `frontend/src/**`, the `mythrun-ui/no-ad-hoc-ui` lint rule bans raw lowercase JSX elements (`<div>`/`<nav>`/`<footer>`/…), `className`, and `style`. (Rule is OFF in `frontend/ui/src/**` + test files — so `@mythrun/ui` component internals may render raw elements.)
- **No hardcoded strings.** Every user-facing string is an i18n key. **Prose** (tagline, CTA, pricing, legal, the h1 title) = `[ph_<name>: <intent + length hint>]`, length-matched — Miklos writes the real copy. **Generic chrome only** ("Sign in", the lockup accessible name, the theme-toggle labels) gets a real value. The `mythrun-ui/no-untranslated-jsx-text` rule bans bare JSX text/string-literal/static-template children outside `<Trans>` — this is why palette token names and any inline text must be held in a `const` or come from `t()`.
- **Every new catalog key needs a `descriptions.ts` entry** in the same change, or `frontend/client-core/src/i18n/resources.test.ts` (set-equality drift test) fails.
- **Named exports only.** Default exports are a repo-root lint error (`no-restricted-syntax`). `*.stories.tsx` is the sole exception — it carries `// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.` above `export default meta`.
- **SPA navigation uses `useNavigate`**, not `Link`. `@mythrun/ui`'s `Link` is a real `<a href>` (full page reload) — correct only for external/`mailto` footer destinations. For internal route changes: `const navigate = useNavigate()` then `<Button onPress={() => void navigate('/auth/signin')}>`.
- **Strict TS:** no `any`, no type assertions unless unavoidable; functions < 50 lines, modules < 400 lines (lint warns at 400/100).
- **Routes stay DOM-free:** `frontend/src/routes/**` bans `document`/`window`/`localStorage`/`fetch`/`WebSocket`/etc. globals and deep `@mythrun/client-core/src/**` imports (use the package root).
- **Responsive:** desktop AND ~375px mweb, by construction. `minHeight="screen"` (→ `min-h-dvh`); the nav's three items (`HorizontalLockup` + 48px toggle + Sign-in) fit at 375px with `justify="between"` slack (no hamburger).
- **Dark-CTA AA is already resolved** (commit `b251053`): dark `--accent` = `ember-400 #94603c` (paper-50 label 4.78:1), dark `--accent-fg` = `ember-300 #b17f56` (4.88:1). The landing consumes these tokens; it does not touch the palette.
- **Visual audit before push.** This is a consumer-facing surface: build → local-OK → STOP for Miklos's exam (light + dark) → incorporate → push.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `frontend/client-core/src/contract/box.ts` | Add `as` to `BoxProps` | 1 |
| `frontend/ui/src/components/Box/Box.tsx` | Render the `as` element | 1 |
| `frontend/ui/src/components/Box/Box.test.tsx` | Assert `as` → tagName; default stays `div` | 1 |
| `frontend/ui/src/components/Box/Box.stories.tsx` | Landmark story | 1 |
| `frontend/client-core/src/contract/theme.ts` | Add `placement` + `ThemeTogglePlacement` | 2 |
| `frontend/ui/src/components/ThemeToggle/ThemeToggle.tsx` | Conditional FAB positioning | 2 |
| `frontend/ui/src/components/ThemeToggle/ThemeToggle.test.tsx` | Assert inline omits `fixed` | 2 |
| `frontend/ui/src/components/ThemeToggle/ThemeToggle.stories.tsx` | Inline story | 2 |
| `frontend/ui/src/index.ts` | Re-export `ThemeTogglePlacement` | 2 |
| `frontend/client-core/src/i18n/locales/en/common.json` | `landing.*` + `theme.toLight/toDark`; later remove `stub.landing` | 3, 4 |
| `frontend/client-core/src/i18n/descriptions.ts` | Matching descriptions; later remove `stub.landing` | 3, 4 |
| `frontend/src/routes/landing.tsx` | The landing screen (nav + hero + dither + footer) | 4, 5, 6 |
| `frontend/src/routes/landing.test.tsx` | Route behaviour (landmarks, nav, CTA, dither gating) | 4, 5, 6 |
| `frontend/src/routes/landing.stories.tsx` | Already renders the real route via `ScreenHarness` — verify only | 6 |
| `frontend/ui/src/styles/semantic-contrast.test.ts` (new) | Dark-accent AA regression guard | 7 |

---

### Task 1: `Box` semantic-landmark `as` prop

**Files:**
- Modify: `frontend/client-core/src/contract/box.ts`
- Modify: `frontend/ui/src/components/Box/Box.tsx`
- Test: `frontend/ui/src/components/Box/Box.test.tsx`
- Modify: `frontend/ui/src/components/Box/Box.stories.tsx`

**Interfaces:**
- Produces: `BoxProps.as?: 'div' | 'nav' | 'main' | 'footer' | 'header' | 'section'` (default `'div'`). `<Box as="nav">` renders a `<nav>`; surface/padding/border/minHeight behaviour unchanged. Consumed by Tasks 4 (`as="nav"`), 5 (`as="main"`), 6 (`as="footer"`).

- [ ] **Step 1: Write the failing tests** — append to `Box.test.tsx`:

```tsx
it('renders the semantic element named by `as`', () => {
  render(<Box as="nav" data-testid="b">x</Box>)
  expect(screen.getByTestId('b').tagName).toBe('NAV')
})

it('renders a footer landmark with a reversed surface', () => {
  render(<Box as="footer" surface="reversed" data-testid="b">x</Box>)
  const el = screen.getByTestId('b')
  expect(el.tagName).toBe('FOOTER')
  expect(el.className).toContain('dark')
})
```
(The existing "defaults to a `<div>`" test — asserting `tagName === 'DIV'` when `as` is omitted — MUST stay green; do not modify it.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @mythrun/ui exec vitest run src/components/Box/Box.test.tsx`
Expected: FAIL — `as` is not a valid prop (TS) / element is still `DIV`.

- [ ] **Step 3: Add `as` to the contract** — `frontend/client-core/src/contract/box.ts`, add as the first member of `BoxProps`:

```ts
export interface BoxProps extends BaseProps {
  /** Semantic landmark element. Default 'div'. Use 'nav'/'main'/'footer'/'header' for page landmarks. */
  as?: 'div' | 'nav' | 'main' | 'footer' | 'header' | 'section'
  padding?: SpaceToken
  surface?: 'base' | 'raised' | 'overlay' | 'reversed'
  border?: boolean
  minHeight?: 'screen'
}
```

- [ ] **Step 4: Render the dynamic element** — `frontend/ui/src/components/Box/Box.tsx`. Change the import line and the component body (the `box` cva block is unchanged). Use `createElement` (clean ref typing for a union of intrinsic tags; avoids a type assertion):

```tsx
import { createElement, forwardRef } from 'react'
// ... (cva `box` block unchanged) ...
export const Box = forwardRef<HTMLElement, BoxProps>(function Box(
  { padding, surface = 'base', border = false, minHeight, as = 'div', children, ...rest },
  ref,
) {
  return createElement(
    as,
    {
      ref,
      className: cn(
        box({ surface, border, ...(minHeight !== undefined && { minHeight }) }),
        padding !== undefined && PADDING_CLASS[padding],
      ),
      ...rest,
    },
    children,
  )
})
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @mythrun/ui exec vitest run src/components/Box/Box.test.tsx`
Expected: PASS (incl. the unchanged default-`div` and ref tests).

- [ ] **Step 6: Add a landmark story** — `Box.stories.tsx`, add an `as` argType and a story:

```tsx
export const Landmark: Story = {
  args: { as: 'section', surface: 'raised', padding: 5, children: 'A section landmark' },
}
```
Add `as: { control: 'select', options: ['div', 'nav', 'main', 'footer', 'header', 'section'] }` to the existing `argTypes`.

- [ ] **Step 7: Verify package green + commit**

Run: `pnpm --filter @mythrun/ui test && pnpm --filter @mythrun/ui typecheck && pnpm --filter @mythrun/ui lint`
Expected: PASS.
```bash
git add frontend/client-core/src/contract/box.ts frontend/ui/src/components/Box/
git commit -m "feat(@mythrun/ui): Box semantic-landmark \`as\` prop"
```

---

### Task 2: `ThemeToggle` `placement` prop (FAB → inline)

**Files:**
- Modify: `frontend/client-core/src/contract/theme.ts`
- Modify: `frontend/ui/src/components/ThemeToggle/ThemeToggle.tsx`
- Test: `frontend/ui/src/components/ThemeToggle/ThemeToggle.test.tsx`
- Modify: `frontend/ui/src/components/ThemeToggle/ThemeToggle.stories.tsx`
- Modify: `frontend/ui/src/index.ts`

**Interfaces:**
- Produces: `ThemeTogglePlacement = 'fab' | 'inline'`; `ThemeToggleProps.placement?: ThemeTogglePlacement` (default `'fab'`). `placement="inline"` drops only the fixed-top-right classes (normal in-flow 48px square). Consumed by Task 4 (the nav cluster). `fab` default leaves signin/onboard untouched.

- [ ] **Step 1: Write the failing tests** — append to `ThemeToggle.test.tsx` (uses the existing `setMatch`/`ThemeProvider` helpers in that file):

```tsx
it('omits the fixed-position classes in inline placement', () => {
  setMatch(false)
  render(<ThemeProvider><ThemeToggle label="Theme" placement="inline" data-testid="tt" /></ThemeProvider>)
  expect(screen.getByTestId('tt').className).not.toContain('fixed')
})

it('keeps the fixed FAB position by default', () => {
  setMatch(false)
  render(<ThemeProvider><ThemeToggle label="Theme" data-testid="tt" /></ThemeProvider>)
  expect(screen.getByTestId('tt').className).toContain('fixed')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @mythrun/ui exec vitest run src/components/ThemeToggle/ThemeToggle.test.tsx`
Expected: FAIL — `placement` not a valid prop.

- [ ] **Step 3: Add the contract** — `frontend/client-core/src/contract/theme.ts`. Add the alias above `ThemeToggleProps`, add the prop, and update the stale "canonical FAB / self-positioning fixed top-right" docstring to mention the two placements:

```ts
export type ThemeTogglePlacement = 'fab' | 'inline'

// The theme toggle. `placement='fab'` (default) is the fixed top-right FAB used
// on genesis screens (signin, onboard). `placement='inline'` drops the fixed
// positioning for a normal in-flow control (e.g. a nav cluster).
export interface ThemeToggleProps extends BaseProps {
  label: string
  placement?: ThemeTogglePlacement
}
```

- [ ] **Step 4: Make positioning conditional** — `ThemeToggle.tsx`. Destructure `placement = 'fab'`, gate the fixed-position class, and update the leading docstring (drop "Self-positioning: `fixed` top-right" → "FAB or inline; see `placement`"):

```tsx
export const ThemeToggle = forwardRef<HTMLButtonElement, ThemeToggleProps>(function ThemeToggle(
  { label, placement = 'fab', ...rest },
  ref,
) {
  const { theme, toggle } = useTheme()
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={toggle}
      className={cn(
        placement === 'fab' && 'fixed top-[var(--space-4)] right-[var(--space-4)] z-[var(--z-nav)]',
        'inline-flex items-center justify-center h-[var(--control-lg)] w-[var(--control-lg)] shrink-0',
        'rounded-none cursor-pointer select-none',
        'bg-surface text-ink border border-border-strong',
        'hover:bg-surface-hover active:bg-surface-active',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
      )}
      {...rest}
    >
      <Icon name={theme === 'dark' ? 'moon' : 'sun'} size="md" decorative />
    </button>
  )
})
```

- [ ] **Step 5: Re-export the alias** — `frontend/ui/src/index.ts`, beside the existing `ThemeToggleProps` re-export (~line 175), add `ThemeTogglePlacement` to the same `export type { … } from '@mythrun/client-core/contract'` group.

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm --filter @mythrun/ui exec vitest run src/components/ThemeToggle/ThemeToggle.test.tsx`
Expected: PASS (the existing flip + axe tests stay green — `fab` is the default).

- [ ] **Step 7: Add an inline story** — `ThemeToggle.stories.tsx`, after `Default`:

```tsx
export const Inline: Story = { args: { label: 'Theme', placement: 'inline' } }
```

- [ ] **Step 8: Verify + commit**

Run: `pnpm --filter @mythrun/ui test && pnpm --filter @mythrun/ui typecheck && pnpm --filter @mythrun/ui lint`
Expected: PASS.
```bash
git add frontend/client-core/src/contract/theme.ts frontend/ui/src/components/ThemeToggle/ frontend/ui/src/index.ts
git commit -m "feat(@mythrun/ui): ThemeToggle inline placement mode"
```

---

### Task 3: `landing.*` + `theme.*` i18n keys + descriptions

**Files:**
- Modify: `frontend/client-core/src/i18n/locales/en/common.json`
- Modify: `frontend/client-core/src/i18n/descriptions.ts`

**Interfaces:**
- Produces these catalog keys (consumed by Tasks 4–6 via `t(...)` / `<Trans>`):
  - Prose `[ph_]`: `landing.title`, `landing.tagline`, `landing.cta`, `landing.pricing`, `landing.legal`.
  - Real chrome: `landing.signin`, `landing.wordmark`, `theme.toLight`, `theme.toDark`.
- This task ADDS keys only. `stub.landing` is removed later (Task 4), atomically with the stub component it still references.

- [ ] **Step 1: Write the failing assertion** — the drift test (`resources.test.ts`) already enforces description↔catalog set-equality. Add a focused expectation to it to pin the new keys (so this task's deliverable is independently testable):

```ts
it('includes the landing keys with descriptions', () => {
  const described = new Set(Object.keys(descriptions))
  for (const k of ['landing.title','landing.tagline','landing.cta','landing.pricing','landing.legal','landing.signin','landing.wordmark','theme.toLight','theme.toDark']) {
    expect(described.has(k)).toBe(true)
  }
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @mythrun/client-core exec vitest run src/i18n/resources.test.ts`
Expected: FAIL — keys absent / set-equality broken.

- [ ] **Step 3: Add the catalog keys** — `common.json`. Add `toLight`/`toDark` inside the existing `"theme"` object, and a new top-level `"landing"` object:

```json
"theme": { "toggle": "Theme", "toLight": "Switch to light theme", "toDark": "Switch to dark theme" },
"landing": {
  "title": "[ph_landing_title: the page's h1 — brand name + what Mythrun is, ~5-8 words, for SEO + screen readers]",
  "tagline": "[ph_landing_tagline: a terse at-the-table line, ~1 sentence — what a session feels like]",
  "cta": "[ph_landing_cta: a terse primary-CTA label — enter a session]",
  "pricing": "[ph_landing_pricing: one line — sessions start at $X, your first is free]",
  "legal": "[ph_landing_legal: <1>Terms</1> · <2>Privacy</2> · <3>Questions?</3> — a short legal/contact line]",
  "signin": "Sign in",
  "wordmark": "Mythrun"
}
```
(Preserve the existing `"theme"` members; only `toggle` exists today — add `toLight`/`toDark`.)

- [ ] **Step 4: Add the descriptions** — `descriptions.ts`, one entry per new key:

```ts
'theme.toLight': 'ThemeToggle accessible name shown while in dark theme (action + target). Real chrome string.',
'theme.toDark': 'ThemeToggle accessible name shown while in light theme (action + target). Real chrome string.',
'landing.title': "The landing page's visually-hidden h1 (SEO + screen-reader document title). Placeholder — Miklos writes it.",
'landing.tagline': 'Hero tagline under the lockup. ~1 sentence, evocative, at-the-table, no hype. Placeholder.',
'landing.cta': 'Hero primary CTA button label. Terse, brand-voiced, enters a session. Placeholder.',
'landing.pricing': 'Transparent pricing line below the hero. One line. Placeholder ($X lands with billing, MYT-95).',
'landing.legal': 'Footer legal/contact line, Trans rich-text: <1>Terms</1> <2>Privacy</2> <3>Questions?</3>. Labels live inside. Placeholder.',
'landing.signin': 'Nav "Sign in" button label. A real shipped string (generic chrome).',
'landing.wordmark': 'Accessible name for the brand lockup (nav + hero). A real shipped string (the brand identity).',
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @mythrun/client-core test`
Expected: PASS (drift set-equality holds; the new assertion passes).

- [ ] **Step 6: Verify the i18n:todo signal**

Run: `pnpm --filter @mythrun/web i18n:todo`
Expected output INCLUDES `landing.title`, `landing.tagline`, `landing.cta`, `landing.pricing`, `landing.legal` (all `[ph_]`); and does NOT list `landing.signin`, `landing.wordmark`, `theme.toLight`, `theme.toDark` (real chrome).

- [ ] **Step 7: Commit**

```bash
git add frontend/client-core/src/i18n/
git commit -m "feat(MYT-86): landing.* + theme toggle i18n keys"
```

---

### Task 4: `LandingRoute` shell + `LandingNav` + remove `stub.landing`

**Files:**
- Modify: `frontend/src/routes/landing.tsx` (replace the stub)
- Test: `frontend/src/routes/landing.test.tsx` (new)
- Modify: `frontend/client-core/src/i18n/locales/en/common.json` (remove `stub.landing`)
- Modify: `frontend/client-core/src/i18n/descriptions.ts` (remove `stub.landing`)

**Interfaces:**
- Consumes: `BoxProps.as` (Task 1), `ThemeToggle placement` (Task 2), `landing.wordmark`/`landing.signin`/`theme.toLight`/`theme.toDark` (Task 3).
- Produces: `export function LandingRoute(): React.JSX.Element` (named) with `data-testid="route-landing"`; a `<nav>` landmark (`landing-nav`) holding the wordmark, an inline `ThemeToggle`, and a Sign-in `Button`. The route-local `LandingNav` is extended by Tasks 5/6 siblings.
- **`stub.landing` removal is atomic here:** the stub component (its only consumer) is replaced in this same task, so the key + description are deleted together (drift stays green).

- [ ] **Step 1: Write the failing test** — `frontend/src/routes/landing.test.tsx` (copy the `MemStorage` + `setMatch` + `beforeAll`/`beforeEach`/`afterEach` boilerplate verbatim from `signin.test.tsx:1-46,68-70,77-88`, minus the auth mocks):

```tsx
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { i18n } from '../i18n/config.ts'
import { LandingRoute } from './landing.tsx'

// (paste the MemStorage class + beforeAll localStorage shim from signin.test.tsx:18-46)

function setMatch(): void {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) })
}

function renderLanding(): void {
  const router = createMemoryRouter(
    [
      { path: '/', element: <LandingRoute /> },
      { path: '/auth/signin', element: <div data-testid="signin-stub" /> },
    ],
    { initialEntries: ['/'] },
  )
  render(<ThemeProvider><I18nextProvider i18n={i18n}><RouterProvider router={router} /></I18nextProvider></ThemeProvider>)
}

beforeEach(() => { setMatch(); localStorage.clear() })
afterEach(() => { cleanup() })

describe('LandingRoute', () => {
  it('renders a <nav> landmark with wordmark, theme toggle, and sign-in', () => {
    renderLanding()
    expect(screen.getByTestId('route-landing')).toBeDefined()
    expect(screen.getByTestId('landing-nav').tagName).toBe('NAV')
    expect(screen.getByTestId('landing-wordmark')).toBeDefined()
    expect(screen.getByTestId('landing-theme-toggle')).toBeDefined()
    expect(screen.getByTestId('landing-signin')).toBeDefined()
  })

  it('navigates to /auth/signin when nav Sign in is pressed', () => {
    renderLanding()
    act(() => { screen.getByTestId('landing-signin').click() })
    expect(screen.getByTestId('signin-stub')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @mythrun/web exec vitest run src/routes/landing.test.tsx`
Expected: FAIL — the stub renders no `landing-nav`.

- [ ] **Step 3: Replace the stub** — `frontend/src/routes/landing.tsx`:

```tsx
import { Box, Stack, HorizontalLockup, ThemeToggle, Button, useTheme } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

// The public landing page (MYT-86). Composed from @mythrun/ui only; nav/main/
// footer are semantic landmarks (Box `as`). Prose is [ph_] i18n; the CTA + nav
// Sign-in route to /auth/signin via SPA navigation.
function LandingNav(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const navigate = useNavigate()
  const toggleLabel = theme === 'dark' ? t('theme.toLight') : t('theme.toDark')
  return (
    <Box as="nav" padding={4} data-testid="landing-nav">
      <Stack direction="row" justify="between" align="center">
        <HorizontalLockup aria-label={t('landing.wordmark')} data-testid="landing-wordmark" />
        <Stack direction="row" align="center" gap={3}>
          <ThemeToggle placement="inline" label={toggleLabel} data-testid="landing-theme-toggle" />
          <Button variant="secondary" onPress={() => void navigate('/auth/signin')} data-testid="landing-signin">
            {t('landing.signin')}
          </Button>
        </Stack>
      </Stack>
    </Box>
  )
}

export function LandingRoute(): React.JSX.Element {
  return (
    <Stack minHeight="screen" data-testid="route-landing">
      <LandingNav />
    </Stack>
  )
}
```

- [ ] **Step 4: Remove `stub.landing`** — delete the `"landing"` member from the `"stub"` object in `common.json`, and delete the `'stub.landing'` entry from `descriptions.ts`. (Grep first to confirm `landing.tsx` is the only consumer: `grep -rn "stub.landing" frontend/` should now show only the catalog + this just-removed reference.)

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @mythrun/web exec vitest run src/routes/landing.test.tsx && pnpm --filter @mythrun/client-core test`
Expected: PASS (landing nav renders + navigates; drift still set-equal after the `stub.landing` removal).

- [ ] **Step 6: Verify typecheck/lint (no dangling `stub.landing` key reference) + commit**

Run: `pnpm --filter @mythrun/web typecheck && pnpm --filter @mythrun/web lint`
Expected: PASS (the typed-key check has no orphaned `t('stub.landing')`).
```bash
git add frontend/src/routes/landing.tsx frontend/src/routes/landing.test.tsx frontend/client-core/src/i18n/
git commit -m "feat(MYT-86): landing nav landmark + retire stub.landing"
```

---

### Task 5: `LandingHero` (main landmark)

**Files:**
- Modify: `frontend/src/routes/landing.tsx`
- Test: `frontend/src/routes/landing.test.tsx`

**Interfaces:**
- Consumes: `BoxProps.as="main"` (Task 1); `landing.title`/`landing.tagline`/`landing.cta`/`landing.pricing`/`landing.wordmark` (Task 3); the `LandingRoute` root (Task 4).
- Produces: a `<main>` landmark (`landing-hero`) with a visually-hidden `h1`, the stacked `Lockup`, the tagline, the primary CTA (→ `/auth/signin`), and the pricing line.

- [ ] **Step 1: Write the failing test** — append to `landing.test.tsx`:

```tsx
it('renders a <main> landmark with a hidden h1, lockup, tagline, CTA, and pricing', () => {
  renderLanding()
  expect(screen.getByTestId('landing-hero').tagName).toBe('MAIN')
  expect(screen.getByRole('heading', { level: 1 })).toBeDefined()
  expect(screen.getByTestId('landing-hero-lockup')).toBeDefined()
  expect(screen.getByTestId('landing-tagline')).toBeDefined()
  expect(screen.getByTestId('landing-pricing')).toBeDefined()
})

it('navigates to /auth/signin when the hero CTA is pressed', () => {
  renderLanding()
  act(() => { screen.getByTestId('landing-cta').click() })
  expect(screen.getByTestId('signin-stub')).toBeDefined()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @mythrun/web exec vitest run src/routes/landing.test.tsx`
Expected: FAIL — no `landing-hero` / no level-1 heading.

- [ ] **Step 3: Add `LandingHero` + wire it into the root** — `landing.tsx`. Extend the `@mythrun/ui` import to add `Lockup, VisuallyHidden, Heading, Text`, add the component, and render it after `<LandingNav />`:

```tsx
import { Box, Stack, HorizontalLockup, Lockup, VisuallyHidden, Heading, Text, ThemeToggle, Button, useTheme } from '@mythrun/ui'

function LandingHero(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <Box as="main" padding={6} data-testid="landing-hero">
      <VisuallyHidden>
        <Heading level={1}>{t('landing.title')}</Heading>
      </VisuallyHidden>
      <Stack align="center" gap={6}>
        <Lockup aria-label={t('landing.wordmark')} data-testid="landing-hero-lockup" />
        <Text as="p" role="prose-body" data-testid="landing-tagline">{t('landing.tagline')}</Text>
        <Button variant="primary" onPress={() => void navigate('/auth/signin')} data-testid="landing-cta">
          {t('landing.cta')}
        </Button>
        <Text role="data" data-testid="landing-pricing">{t('landing.pricing')}</Text>
      </Stack>
    </Box>
  )
}
```
In `LandingRoute`, render `<LandingHero />` directly under `<LandingNav />`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @mythrun/web exec vitest run src/routes/landing.test.tsx`
Expected: PASS (hero landmark + hidden h1 + CTA navigation).

- [ ] **Step 5: Verify + commit**

Run: `pnpm --filter @mythrun/web typecheck && pnpm --filter @mythrun/web lint`
Expected: PASS.
```bash
git add frontend/src/routes/landing.tsx frontend/src/routes/landing.test.tsx
git commit -m "feat(MYT-86): landing hero — hidden h1, lockup, tagline, CTA, pricing"
```

---

### Task 6: `LandingFooter` + dither transition + final assembly

**Files:**
- Modify: `frontend/src/routes/landing.tsx`
- Test: `frontend/src/routes/landing.test.tsx`
- Verify: `frontend/src/routes/landing.stories.tsx` (no change expected)

**Interfaces:**
- Consumes: `BoxProps.as="footer" surface="reversed"` (Task 1); `Dither` + `Link` + `<Trans>`; `landing.legal` (Task 3); `useTheme` (already imported).
- Produces: a `<footer>` landmark (`landing-footer`) with the Trans rich-text legal line (Terms/Privacy/Questions links); the page→footer `Dither` (`landing-dither`) rendered **only in light theme**.

- [ ] **Step 1: Write the failing test** — append to `landing.test.tsx`. (Default render is light via `setMatch(false)`; toggle to dark to assert the dither is gated.)

```tsx
it('renders a <footer> landmark with Terms / Privacy / Questions links', () => {
  renderLanding()
  expect(screen.getByTestId('landing-footer').tagName).toBe('FOOTER')
  expect(screen.getByTestId('landing-terms')).toBeDefined()
  expect(screen.getByTestId('landing-privacy')).toBeDefined()
  expect(screen.getByTestId('landing-questions')).toBeDefined()
})

it('renders the page→footer dither in light theme only', () => {
  renderLanding()
  expect(screen.getByTestId('landing-dither')).toBeDefined()       // light (default)
  act(() => { screen.getByTestId('landing-theme-toggle').click() }) // → dark
  expect(screen.queryByTestId('landing-dither')).toBeNull()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @mythrun/web exec vitest run src/routes/landing.test.tsx`
Expected: FAIL — no footer / no dither.

- [ ] **Step 3: Add `LandingFooter`, the dither, and finish the root** — `landing.tsx`. Extend the import to add `Dither, Link`; add `Trans` from `react-i18next`; add the footer; gate the dither in `LandingRoute`:

```tsx
import { Box, Stack, HorizontalLockup, Lockup, VisuallyHidden, Heading, Text, Dither, Link, ThemeToggle, Button, useTheme } from '@mythrun/ui'
import { Trans, useTranslation } from 'react-i18next'

function LandingFooter(): React.JSX.Element {
  return (
    <Box as="footer" surface="reversed" padding={6} data-testid="landing-footer">
      <Stack align="center" gap={2}>
        <Text role="ui-caption" data-testid="landing-legal">
          <Trans
            i18nKey="landing.legal"
            components={{
              1: <Link href="/terms" data-testid="landing-terms" />,
              2: <Link href="/privacy" data-testid="landing-privacy" />,
              3: <Link href="mailto:hello@mythrun.dev" external data-testid="landing-questions" />,
            }}
          />
        </Text>
      </Stack>
    </Box>
  )
}

export function LandingRoute(): React.JSX.Element {
  const { theme } = useTheme()
  return (
    <Stack minHeight="screen" data-testid="route-landing">
      <LandingNav />
      <LandingHero />
      {theme === 'light' ? (
        <Dither from="paper-100" to="paper-900" scale="hero" data-testid="landing-dither" />
      ) : null}
      <LandingFooter />
    </Stack>
  )
}
```
Notes for the implementer: the `<Trans>` children satisfy `no-untranslated-jsx-text` (Trans is exempt); the `Link` components (not raw `<a>`) satisfy `no-ad-hoc-ui`. `/terms` + `/privacy` are intended-but-unrouted placeholders (clicking them full-navigates → the app's catch-all 404 until a follow-up adds the routes — acceptable per the spec). `Questions?` is a real `mailto:` (swap target later if Miklos prefers Discord).

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @mythrun/web exec vitest run src/routes/landing.test.tsx`
Expected: PASS — footer landmark, three links, dither light-only.

- [ ] **Step 5: Full landing verification**

Run:
```
pnpm --filter @mythrun/web test
pnpm --filter @mythrun/web typecheck && pnpm --filter @mythrun/web lint
pnpm --filter @mythrun/web screen-story-coverage
pnpm --filter @mythrun/web i18n:todo
```
Expected: web tests PASS; typecheck/lint clean; `screen-story-coverage` PASS (the existing `landing.stories.tsx` renders the real route via `ScreenHarness` — no change needed); `i18n:todo` lists the four landing `[ph_]` prose keys.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/landing.tsx frontend/src/routes/landing.test.tsx
git commit -m "feat(MYT-86): landing footer (inverted) + light-only dither transition"
```

---

### Task 7: Dark-accent contrast regression guard

**Files:**
- Test: `frontend/ui/src/styles/semantic-contrast.test.ts` (new)

**Interfaces:**
- Consumes: the generated palette (`generatePalette()` from `frontend/client-core/src/tokens/generate-palette.mjs`) + `wcagContrast` from `culori` (already a dep of the generator).
- Produces: a standing test that fails if a future palette change re-breaks the AA floors the landing CTA + links depend on. Independent of Tasks 1–6.

- [ ] **Step 1: Write the test** — `frontend/ui/src/styles/semantic-contrast.test.ts`. Assert the ramp steps the accent tokens resolve to (per `semantic.css`: dark `--accent` = `ember-400`, dark `--accent-fg` = `ember-300`, light `--accent` = `ember-500`) clear their WCAG floors against the paper grounds:

```ts
import { describe, it, expect } from 'vitest'
import { wcagContrast } from 'culori'
import { generatePalette } from '@mythrun/client-core/tokens/generate-palette.mjs'

const p = generatePalette()
const PAPER_50 = p.paper[50]    // light text on the accent fill
const PAPER_900 = p.paper[900]  // the dark page ground

describe('semantic accent contrast (regression guard for the MYT-86 dark CTA)', () => {
  it('dark --accent fill (ember-400) carries paper-50 label at AA', () => {
    expect(wcagContrast(p.ember[400], PAPER_50)).toBeGreaterThanOrEqual(4.5)
  })
  it('light --accent fill (ember-500) carries paper-50 label at AA', () => {
    expect(wcagContrast(p.ember[500], PAPER_50)).toBeGreaterThanOrEqual(4.5)
  })
  it('dark --accent-fg (ember-300) reads as text on the dark page at AA', () => {
    expect(wcagContrast(p.ember[300], PAPER_900)).toBeGreaterThanOrEqual(4.5)
  })
})
```
(If a `@mythrun/client-core/tokens/...` import path is not exported, import the generator by relative path the way `generate-palette.test.ts` does — check that test for the exact specifier.)

- [ ] **Step 2: Run to verify it passes against the shipped palette**

Run: `pnpm --filter @mythrun/ui exec vitest run src/styles/semantic-contrast.test.ts`
Expected: PASS (b251053's palette clears all three: 4.78 / 5.30 / 4.88).

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @mythrun/ui test && pnpm --filter @mythrun/ui typecheck && pnpm --filter @mythrun/ui lint`
Expected: PASS.
```bash
git add frontend/ui/src/styles/semantic-contrast.test.ts
git commit -m "test(@mythrun/ui): dark-accent AA contrast regression guard"
```

---

## Final verification (before the visual-audit gate)

After Task 7, run the full sweep:
```
pnpm -r typecheck
pnpm -r lint
pnpm --filter @mythrun/ui test
pnpm --filter @mythrun/client-core test
pnpm --filter @mythrun/web test
pnpm --filter @mythrun/web screen-story-coverage
pnpm --filter @mythrun/web i18n:todo
```
Then **STOP for Miklos's visual audit** (Storybook `Screens/Landing` at 375 + 1280, light + dark) before any push. Do not push until he signs off — the palette commit (`b251053`) rides in the same push.

## Self-Review

**1. Spec coverage:**
- Nav (HorizontalLockup + inline toggle + secondary Sign-in → /auth/signin, 375px no-hamburger) → Task 4. ✓
- Hero (hidden h1 + stacked Lockup + [ph_] tagline + ember primary CTA → /auth/signin) → Task 5. ✓
- Pricing line ([ph_], data/mono role) → Task 5. ✓
- Dither (paper-100→paper-900, scale=hero, light-theme only) → Task 6. ✓
- Inverted footer (Box surface=reversed, Trans legal w/ Terms/Privacy/Questions) → Task 6. ✓
- ThemeToggle placement prop (fab default, inline) + ThemeTogglePlacement alias + docstrings → Task 2. ✓
- Box landmark `as` → Task 1. ✓
- landing.* [ph_] prose + chrome real values + descriptions + remove stub.landing → Tasks 3 + 4. ✓
- Toggle accessible name action/state-oriented → Task 3 (theme.toLight/toDark) + Task 4 (landing computes via useTheme). ✓
- Verification: landmarks, hidden h1, navigation, dither gating, i18n:todo inclusion/exclusion, screen-story-coverage, dark-CTA contrast guard → Tasks 4–7. ✓
- Deferred (3-section scroll, demo, real $X, Terms/Privacy routes, authed app-frame inline toggle) → not in plan, correctly. ✓

**2. Placeholder scan:** No "TBD"/"handle appropriately"/"similar to Task N". Every code step shows complete code; every run step shows the command + expected result. ✓

**3. Type consistency:** `BoxProps.as` enum identical across Tasks 1/4/5/6. `ThemeTogglePlacement = 'fab' | 'inline'` consistent (Task 2 def, Task 4 use). `data-testid` names consistent across impl + tests (`route-landing`, `landing-nav`, `landing-wordmark`, `landing-theme-toggle`, `landing-signin`, `landing-hero`, `landing-hero-lockup`, `landing-tagline`, `landing-cta`, `landing-pricing`, `landing-footer`, `landing-legal`, `landing-terms`, `landing-privacy`, `landing-questions`, `landing-dither`). Catalog keys identical between Task 3 (def) and Tasks 4–6 (use). ✓

**One open implementer note (not a blocker):** the nav `HorizontalLockup` and the hero `Lockup` both use `landing.wordmark` ("Mythrun") as their `aria-label` — two `role="img"` elements with the same name. Acceptable (the brand mark in two places); if the visual audit finds it noisy for SR, the nav lockup can take a distinct label in a follow-up.
