# MYT-97 — mythrunUI Responsiveness + Mobile-Viewport Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan. Each task below is a self-contained TDD cycle (failing test → implementation → green → commit). Tasks 1–5 are independent (non-overlapping files) and may be dispatched in parallel; Tasks 6–12 form a dependency chain (see "Task dependencies"). All implementer subagents run **Opus**. Implementers do **not** `git add`/`commit`/`push` — the controller stages and commits each task's files serially.

**Goal:** Give every mythrunUI primitive intrinsic constrained-width behavior and stand up a durable CI gate that renders every component *and* assembled-screen story at 375px and 1280px and fails the build on horizontal overflow.

**Architecture:** Add intrinsic-shrink capabilities to four primitives (Stack `min-w-0` children + `wrap`, Text `truncate`, Button/Icon `shrink-0`) behind platform-neutral contract props, then stand up a single frontend-level Storybook scanning both `@mythrun/ui` and `@mythrun/web` stories plus a `@storybook/test-runner` overflow gate that measures `max(#storybook-root, document.body).scrollWidth ≤ window.innerWidth + 1` at 375px/1280px. Assembled-screen stories mount the real route tree through a router-bearing seeded harness (MemoryRouter + seeded QueryClient + session `ready`), so the composition layer where the app-frame header bug lived is gated too, enforced by a screen-story-coverage forcing function. Wiring is CI-first (`frontend-check.yml`); the slow Playwright sweep is kept out of `pre-push`.

**Tech Stack:** React 19 · Vite 6 · Tailwind v4 (`@tailwindcss/vite`) · class-variance-authority · Storybook 9 (`@storybook/react-vite` `^9.1.20`) · `@storybook/test-runner` (Playwright/Chromium) · Vitest 3 · TypeScript strict · pnpm workspaces.

## Global Constraints

- **TDD required** — a failing test (unit, or the gate going red) defines "done" before any implementation code.
- **Named exports only, no default exports** — the sole exceptions are Storybook CSF `meta` and tool-config files (Storybook/test-runner config), each via an inline `// eslint-disable-next-line no-restricted-syntax` or the `.storybook/` dot-dir lint skip.
- **Strict TypeScript** — no `any`, no type assertions unless unavoidable (and justified inline).
- **Functions < 50 lines, files < 400 lines.**
- **Tailwind v4 + CVA token classes only** — no raw color values; tint via `text-*`/`bg-*` token utilities (R3). Non-color arbitrary values (`min-w-0`, `shrink-0`) are allowed.
- **The component prop contract lives in `frontend/client-core/src/contract/`** and stays platform-neutral — no DOM types; `min-w-0`/`shrink-0` are web impl details, never contract props.
- **Any breakpoint use carries a `@platform-divergent: breakpoint` doc-comment** (so `grep -rn '@platform-divergent: breakpoint'` enumerates native-port divergence points). No lint bans breakpoints. (None of this ticket's changes use a breakpoint — all four primitive changes are intrinsic — but the marker convention is in force for any that arrive.)
- **All subagents Opus.**
- **Implementers do NOT `git add`/`commit`/`push`** — the controller stages + commits per task.

## Runner decision (resolved): `@storybook/test-runner`

**Chosen:** `@storybook/test-runner` (Playwright-backed), pinned `">=0.19.0 <0.24.0"`. **Not** `@storybook/addon-vitest`.

**Justification (verified against the Storybook 9 testing docs + the test-runner compatibility table):** The gate is a single *cross-cutting, per-story, viewport-resize + overflow* assertion that must run after every story **without editing each story**. `@storybook/test-runner` exposes exactly that — a global `postVisit(page, context)` hook with a real Playwright `Page`, so `page.setViewportSize(...)` + a `scrollWidth`/`innerWidth` measurement live in one config file and apply to all ~80 stories automatically. The Vitest addon (browser mode) has **no documented global post-render hook**; its model is per-story `play` functions, which would force the viewport/overflow assertion into every story (or a bespoke Vitest-browser setup) and couple the gate to story authoring. The test-runner is officially SB9-compatible (compat table: `^0.19.0` → Storybook `^9.0.0`; the current `0.24.x` line is SB10-only, hence the `<0.24.0` ceiling), consumes the `build-storybook` artifact CI already produces, and runs in real Chromium so React-Router v7's data router works without the jsdom-native-fetch shim. The docs' "superseded by the Vitest addon" note is about component *interaction*-testing ergonomics, not cross-cutting layout sweeps — which remain the test-runner's sweet spot. The bring-up task (Task 8) verifies the resolved version is `< 0.24` via `pnpm why @storybook/test-runner`.

## Topology decision (resolved): one frontend-level Storybook in `@mythrun/web`

Per spec §5, there is **one** Storybook, hosted in `@mythrun/web` (config at `frontend/.storybook/`), scanning **both** `../ui/src/**/*.stories.tsx` and `../src/**/*.stories.tsx`. Hosting web stories in the *ui* Storybook is ruled out (it inverts the dependency `ui → web`, a package cycle — web already depends on ui). `@mythrun/web` already depends on `@mythrun/ui`, so a web-level Storybook depends *down* the graph correctly. The existing `frontend/ui/.storybook/` is retired and its `storybook`/`build-storybook` scripts move to `@mythrun/web`; the ui `story-coverage` gate stays. The web Storybook gets its own Vite/Tailwind-v4/`@fontsource`/token setup and a **screen-aware preview**: component stories keep the `p-6` specimen padding + `a11y:{test:'error'}`; screen stories set `layout:'fullscreen'` (edge-to-edge, no `p-6`) + `a11y:{test:'off'}` (a11y is out of scope this ticket). Standing this up is a first-class task (Task 6).

## Task dependencies

- **Tasks 1–5** (primitives + box comment) — independent, non-overlapping files, parallel-safe.
- **Task 6** (stand up Storybook) — independent of 1–5; needed by 8–11.
- **Task 7** (screen-story-coverage script) — independent; wired by 12.
- **Task 8** (the gate) — depends on 6.
- **Task 9** (overlay-open + wide opt-outs) — depends on 6, 8.
- **Task 10** (screen stories) — depends on 6, 8, and Tasks 1–2 (uses `truncate`/`min-w-0` seeds).
- **Task 11** (header fix, red→green) — depends on 2, 6, 8, 10.
- **Task 12** (CI + pre-push wiring) — depends on 7, 8.

a11y is explicitly **out of scope** (overflow-only). Do not wire axe into `postVisit`.

---

## Task 1 — Stack: `min-w-0` on children + `wrap` prop

**Files:**
- Modify `frontend/client-core/src/contract/stack.ts` (add one prop, lines 9–18).
- Modify `frontend/ui/src/components/Stack/Stack.tsx` (CVA base + a variant + destructure, lines 10–47).
- Modify `frontend/ui/src/components/Stack/Stack.test.tsx` (append 3 tests after line 60).
- Modify `frontend/ui/src/components/Stack/Stack.stories.tsx` (append a `Wrapping` story after line 78).

**Interfaces:**
- Produces contract: `StackProps.wrap?: boolean`.
- Produces impl: `Stack` applies `[&>*]:min-w-0` always and `flex-wrap` when `wrap` is set.
- Consumes: `cva`, `StackProps`, `cn`, `GAP_CLASS` (unchanged imports).

**Steps:**

1. **(test, red)** Append to `Stack.test.tsx` after the `justify` test (line 60), mirroring the file's `classList.contains` style (this file asserts via native DOM, not jest-dom):
   ```tsx
     it('applies min-w-0 to its children so they can shrink under constraint', () => {
       const { getByTestId } = render(<Stack data-testid="stack">x</Stack>)
       expect(getByTestId('stack').classList.contains('[&>*]:min-w-0')).toBe(true)
     })

     it('wraps children onto multiple lines when wrap is set', () => {
       const { getByTestId } = render(
         <Stack data-testid="stack" direction="row" wrap>
           x
         </Stack>,
       )
       expect(getByTestId('stack').classList.contains('flex-wrap')).toBe(true)
     })

     it('does not wrap by default', () => {
       const { getByTestId } = render(<Stack data-testid="stack">x</Stack>)
       expect(getByTestId('stack').classList.contains('flex-wrap')).toBe(false)
     })
   ```
   Run `pnpm --filter @mythrun/ui test Stack` → **fails** (`wrap` not a prop; `[&>*]:min-w-0` / `flex-wrap` absent). This is the TDD red.

2. **(contract)** In `frontend/client-core/src/contract/stack.ts`, add after the `justify` prop (after line 17, before the closing `}` on line 18):
   ```ts
     /** Allow children to wrap onto multiple main-axis lines when they overflow. */
     wrap?: boolean
   ```

3. **(impl)** Replace the CVA + render in `Stack.tsx`. The CVA base gains `[&>*]:min-w-0`, a `wrap` boolean variant is added, and `wrap` is destructured + threaded:
   ```tsx
   // Enum variants (direction/align/justify/wrap) are fixed sets → CVA. The gap is
   // an open SpaceToken, so it comes from the GAP_CLASS lookup (full static
   // classes), not a CVA variant. No colors here — pure layout.
   //
   // `[&>*]:min-w-0` is the canonical flex-shrink unblocker (§3): the flex
   // `min-width:auto` default floors children at their content width, so a long
   // child can't shrink and forces overflow. Setting min-width:0 on every direct
   // child removes that floor (no effect when there's slack) and cascades through
   // nested Stacks. The graceful outcome itself is the child's job (Text.truncate,
   // wrap). NOTE (R2/native): min-w-0 is a WEB impl detail, not a contract prop —
   // React Native's Yoga defaults flexShrink to 0, so the native Stack must opt
   // each shrinkable child in explicitly.
   const stack = cva('flex [&>*]:min-w-0', {
     variants: {
       direction: {
         row: 'flex-row',
         column: 'flex-col',
       },
       align: {
         start: 'items-start',
         center: 'items-center',
         end: 'items-end',
         stretch: 'items-stretch',
       },
       justify: {
         start: 'justify-start',
         center: 'justify-center',
         end: 'justify-end',
         between: 'justify-between',
       },
       wrap: {
         true: 'flex-wrap',
         false: '',
       },
     },
     defaultVariants: {
       direction: 'column',
     },
   })

   export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
     { direction = 'column', gap, align, justify, wrap, children, ...rest },
     ref,
   ) {
     return (
       <div
         ref={ref}
         className={cn(
           stack({ direction, align, justify, wrap }),
           gap !== undefined && GAP_CLASS[gap],
         )}
         {...rest}
       >
         {children}
       </div>
     )
   })
   ```
   (`wrap` is destructured out of `...rest` so it is never spread onto the DOM `<div>`.)

4. **(story)** Append to `Stack.stories.tsx` after `CenterAligned` (line 78). The demo wrapper uses `max-w-full` per the gate's wide-by-design convention:
   ```tsx
   export const Wrapping: Story = {
     name: 'Row · wrap',
     args: { direction: 'row', gap: 3, wrap: true },
     render: (args) => (
       <div className="max-w-full">
         <Stack {...args}>
           {['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'].map((label) => (
             <Cell key={label} label={label} />
           ))}
         </Stack>
       </div>
     ),
   }
   ```

5. **(verify)** Run `pnpm --filter @mythrun/ui test Stack` → expect:
   ```
    ✓ src/components/Stack/Stack.test.tsx (10 tests)
    Test Files  1 passed (1)
         Tests  10 passed (10)
   ```
   Then `pnpm --filter @mythrun/ui typecheck && pnpm --filter @mythrun/client-core typecheck` → no errors.

6. **(commit)** `feat(MYT-97): Stack min-w-0 children + wrap prop`. Files: the four above. **Do not push.**

---

## Task 2 — Text: `truncate` prop (single-line ellipsis)

**Files:**
- Modify `frontend/client-core/src/contract/text.ts` (add one prop, lines 17–22).
- Modify `frontend/ui/src/components/Text/Text.tsx` (import `cn`, destructure + compose className, lines 1–26).
- Modify `frontend/ui/src/components/Text/Text.test.tsx` (append 2 tests after line 43).
- Modify `frontend/ui/src/components/Text/Text.stories.tsx` (append a `Truncated` story after line 50).

**Interfaces:**
- Produces contract: `TextProps.truncate?: boolean`.
- Produces impl: when `truncate`, appends `overflow-hidden text-ellipsis whitespace-nowrap`.
- Consumes: `cn` (new import), `TYPE_ROLE_CLASS` (unchanged).

**Steps:**

1. **(test, red)** Append to `Text.test.tsx` after the `it.each` role block (line 43), using this file's jest-dom `toHaveClass` style:
   ```tsx
     it('truncates to a single line with an ellipsis when truncate is set', () => {
       const { getByTestId } = render(
         <Text data-testid="t" truncate>
           a very long label that cannot fit on one line
         </Text>,
       )
       expect(getByTestId('t')).toHaveClass('overflow-hidden', 'text-ellipsis', 'whitespace-nowrap')
     })

     it('does not truncate by default (wraps)', () => {
       const { getByTestId } = render(<Text data-testid="t">x</Text>)
       expect(getByTestId('t')).not.toHaveClass('whitespace-nowrap')
     })
   ```
   Run `pnpm --filter @mythrun/ui test Text` → **fails** (`truncate` not a prop). TDD red.

2. **(contract)** In `frontend/client-core/src/contract/text.ts`, add after the `as` prop (inside the interface, after line 21):
   ```ts
     /** Truncate to a single line with a trailing ellipsis when the text overflows its container. */
     truncate?: boolean
   ```

3. **(impl)** Replace `Text.tsx` body so it imports `cn`, destructures `truncate`, and composes the class. Full file:
   ```tsx
   import { forwardRef } from 'react'
   import type { TextProps } from '@mythrun/client-core/contract'
   import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
   import { cn } from '../../lib/cn.ts'

   // Inline/block text primitive. The `role` selects a full static token class
   // string from TYPE_ROLE_CLASS; `as` selects the semantic element from a fixed
   // {span,p} enum (NOT a DOM passthrough — no className/style prop). `truncate`
   // is the opt-in single-line ellipsis (overflow-hidden + text-ellipsis +
   // whitespace-nowrap); in a flex context it relies on the parent Stack's
   // [&>*]:min-w-0 so the item can shrink below its content. NOTE (R2/native): the
   // native Text re-implements `truncate` as numberOfLines={1}, same contract.
   export const Text = forwardRef<HTMLElement, TextProps>(function Text(
     { role = 'prose-body', as = 'span', truncate = false, children, ...rest },
     ref,
   ) {
     const className = cn(
       TYPE_ROLE_CLASS[role],
       truncate && 'overflow-hidden text-ellipsis whitespace-nowrap',
     )
     if (as === 'p') {
       return (
         <p ref={ref as React.Ref<HTMLParagraphElement>} className={className} {...rest}>
           {children}
         </p>
       )
     }
     return (
       <span ref={ref} className={className} {...rest}>
         {children}
       </span>
     )
   })
   ```
   (`truncate` is destructured out of `...rest` so it is not spread onto the DOM element.)

4. **(story)** Append to `Text.stories.tsx` after `Data` (line 50). The Text is placed inside a `Stack` row so it is a flex item with `min-w-0` and actually ellipsizes (an inline span in a plain block won't):
   ```tsx
   export const Truncated: Story = {
     name: 'Truncated (single line)',
     args: { role: 'ui-label', truncate: true },
     render: (args) => (
       <div className="max-w-[220px]">
         <Stack direction="row">
           <Text {...args}>A display name that is far too long to fit on one comfortable line</Text>
         </Stack>
       </div>
     ),
   }
   ```
   Add `import { Stack } from '../Stack/Stack.tsx'` to the story file's imports (after the `Text` import, line 2).

5. **(verify)** `pnpm --filter @mythrun/ui test Text` → 7 tests pass. Then `pnpm --filter @mythrun/ui typecheck && pnpm --filter @mythrun/client-core typecheck`.

6. **(commit)** `feat(MYT-97): Text truncate prop (single-line ellipsis)`. **Do not push.**

---

## Task 3 — Button: `shrink-0` fixed-affordance protection

**Files:**
- Modify `frontend/ui/src/components/Button/Button.tsx` (base CVA layout line, line 63).
- Modify `frontend/ui/src/components/Button/Button.test.tsx` (append 1 test after line 159).
- Modify `frontend/ui/src/components/Button/Button.stories.tsx` (append a composition story).

**Interfaces:** No contract change (`shrink-0` is an impl detail). Produces: `Button` carries `shrink-0` (never spills/shrinks under the Stack's blanket `min-w-0`).

**Steps:**

1. **(test, red)** Append to `Button.test.tsx` after the touch-target test block (after line 159):
   ```tsx
     it('opts out of flex-shrink so it keeps its size beside shrinking content (shrink-0)', () => {
       const { getByRole } = render(<Button>Settings</Button>)
       expect(getByRole('button')).toHaveClass('shrink-0')
     })
   ```
   Run `pnpm --filter @mythrun/ui test Button` → **fails**. TDD red.

2. **(impl)** In `Button.tsx`, line 63, add `shrink-0` to the layout class (keep `whitespace-nowrap`; no `overflow-hidden`, no truncate — a button must never clip its label):
   ```tsx
       // Layout: label + (optional) spinner sit on one row, centered, never wrapping.
       // shrink-0 (§4): the fixed action affordance opts OUT of the blanket Stack
       // min-w-0 default so a button never spills or squishes beside shrinking text.
       'inline-flex items-center justify-center whitespace-nowrap shrink-0',
   ```

3. **(story)** Append to `Button.stories.tsx` a composition that shows the button holding its size beside a truncating label (add `import { Stack } from '../Stack/Stack.tsx'` and `import { Text } from '../Text/Text.tsx'` to the imports):
   ```tsx
   export const HoldsSizeBesideShrinkingText: Story = {
     name: 'Holds size beside shrinking text',
     render: () => (
       <div className="max-w-[260px]">
         <Stack direction="row" align="center" justify="between" gap={3}>
           <Text role="ui-label" truncate>
             A long identity label that must give way to the action
           </Text>
           <Button>Settings</Button>
         </Stack>
       </div>
     ),
   }
   ```

4. **(verify)** `pnpm --filter @mythrun/ui test Button` → all pass (28 tests). `pnpm --filter @mythrun/ui typecheck`.

5. **(commit)** `feat(MYT-97): Button shrink-0 fixed-affordance protection`. **Do not push.**

---

## Task 4 — Icon: `shrink-0` (bare icon never squishes)

**Files:**
- Modify `frontend/ui/src/components/Icon/Icon.tsx` (import `cn`, compose className, lines 1–3 + line 45).
- Modify `frontend/ui/src/components/Icon/Icon.test.tsx` (append 1 test after line 51).
- Modify `frontend/ui/src/components/Icon/Icon.stories.tsx` (append a composition story).

**Interfaces:** No contract change. Produces: bare `Icon` carries `shrink-0`.

**Steps:**

1. **(test, red)** Append to `Icon.test.tsx` after the "requested token size" test (after line 51):
   ```tsx
     it('opts out of flex-shrink so it never squishes beside shrinking text (shrink-0)', () => {
       const { container } = render(<Icon name="menu" decorative />)
       expect(container.querySelector('svg')).toHaveClass('shrink-0')
     })
   ```
   Run `pnpm --filter @mythrun/ui test Icon` → **fails**. TDD red.

2. **(impl)** In `Icon.tsx`, add the `cn` import after line 2:
   ```tsx
   import { GLYPHS } from './glyphs.ts'
   import { cn } from '../../lib/cn.ts'
   ```
   and change the svg `className` (line 45) to:
   ```tsx
         className={cn('shrink-0', ICON_SIZE_CLASS[size])}
   ```
   Add to the sizing comment block (after the `ICON_SIZE_CLASS` note, ~line 27) one line:
   ```tsx
   // shrink-0 (§4): a bare Icon is a fixed affordance — it opts out of the blanket
   // Stack min-w-0 default so the glyph never squishes beside shrinking text.
   ```

3. **(story)** Append to `Icon.stories.tsx` (add `import { Stack } from '../Stack/Stack.tsx'` and `import { Text } from '../Text/Text.tsx'`):
   ```tsx
   export const HoldsSizeBesideShrinkingText: Story = {
     name: 'Holds size beside shrinking text',
     render: () => (
       <div className="max-w-[200px]">
         <Stack direction="row" align="center" gap={2}>
           <Icon name="search" decorative />
           <Text role="ui-label" truncate>
             A long string that must shrink, not the icon
           </Text>
         </Stack>
       </div>
     ),
   }
   ```

4. **(verify)** `pnpm --filter @mythrun/ui test Icon` → all pass (9 tests). `pnpm --filter @mythrun/ui typecheck`.

5. **(commit)** `feat(MYT-97): Icon shrink-0 (bare glyph never squishes)`. **Do not push.**

---

## Task 5 — Fix stale `box.ts` `100vh` comment → `100dvh`

**Files:** Modify `frontend/client-core/src/contract/box.ts` (comment lines 26–30).

**Interfaces:** Doc-comment only; no type/behavior change. `Box.tsx` already ships `min-h-dvh` (100dvh); the contract comment is the only drift.

**Steps:**

1. **(impl)** In `box.ts`, replace the `minHeight` doc comment so it reads `100dvh` and explains the dynamic viewport:
   ```ts
     /**
      * Minimum block size. `screen` floors the box at the full *dynamic* viewport
      * height (`100dvh` — fills the mobile screen where `100vh` leaves a white gap
      * under the browser chrome) — a full-screen root, e.g. the dithered 404, where
      * the surface must fill the viewport with no other surface showing below it.
      */
     minHeight?: 'screen'
   ```

2. **(verify)** `pnpm --filter @mythrun/client-core typecheck && pnpm --filter @mythrun/client-core lint` → no errors. (No unit test — this is a comment fix; the existing `Box` tests already assert `min-h-dvh`.)

3. **(commit)** `docs(MYT-97): correct box.ts minHeight comment 100vh → 100dvh`. **Do not push.**

---

## Task 6 — Stand up the frontend-level Storybook (`@mythrun/web`)

**Files:**
- Create `frontend/.storybook/main.ts` (~25 lines).
- Create `frontend/.storybook/preview.tsx` (~75 lines).
- Create `frontend/.storybook/storybook.css` (~10 lines).
- Create `frontend/src/storybook/screen-harness.tsx` (~70 lines).
- Modify `frontend/package.json` (devDeps + scripts).
- Modify `frontend/tsconfig.json` (include `.storybook/**/*`).
- Modify `frontend/eslint.config.js` (add `storybook-static/**` to the ignore list, line ~148).
- Delete `frontend/ui/.storybook/` (3 files) and remove `storybook`/`build-storybook` scripts from `frontend/ui/package.json` (keep `story-coverage`).
- Modify root `.gitignore` (add `frontend/storybook-static/`).

**Interfaces:**
- Produces `ScreenHarness` + `expectScreen` (consumed by Tasks 10/11 screen stories).
- Produces a built Storybook scanning `../ui/src/**/*.stories.tsx` + `../src/**/*.stories.tsx`.

**Steps:**

1. **(deps)** Add to `frontend/package.json` `devDependencies` (mirror ui's Storybook stack; `@tailwindcss/vite` is already present):
   ```jsonc
   "storybook": "^9.1.20",
   "@storybook/react-vite": "^9.1.20",
   "@storybook/addon-a11y": "^9.1.20",
   "@storybook/test-runner": ">=0.19.0 <0.24.0",
   "concurrently": "^9.1.0",
   "http-server": "^14.1.1",
   "wait-on": "^8.0.1"
   ```
   and to `scripts`:
   ```jsonc
   "storybook": "storybook dev -p 6006",
   "build-storybook": "storybook build",
   "test-storybook": "test-storybook --url http://127.0.0.1:6006",
   "test-storybook:ci": "concurrently -k -s first -n SB,TEST -c magenta,blue \"http-server storybook-static --port 6006 --silent\" \"wait-on tcp:127.0.0.1:6006 && pnpm test-storybook\"",
   "screen-story-coverage": "node scripts/screen-story-coverage.mjs"
   ```
   Run `pnpm install`. Then **verify the test-runner resolved under SB9, not SB10:** `pnpm --filter @mythrun/web why @storybook/test-runner` → the resolved version must be `< 0.24.0`. If pnpm resolved `0.24.x`, pin a concrete SB9 version (e.g. `0.23.0`) and reinstall.

2. **(config — main.ts)** Create `frontend/.storybook/main.ts`:
   ```ts
   import type { StorybookConfig } from '@storybook/react-vite'
   import tailwindcss from '@tailwindcss/vite'

   // The ONE frontend-level Storybook (MYT-97 §5). It scans BOTH the design
   // system (../ui/src) and the app shell (../src) stories — hosted in @mythrun/web
   // because web already depends on ui (hosting web stories in the ui Storybook
   // would invert the dependency into a cycle). The 375/1280 overflow gate
   // (test-runner) runs against the build this config produces.
   const config: StorybookConfig = {
     framework: '@storybook/react-vite',
     stories: ['../ui/src/**/*.stories.tsx', '../src/**/*.stories.tsx'],
     addons: ['@storybook/addon-a11y'],
     // Storybook builds its preview through its OWN Vite config. Pushing
     // @tailwindcss/vite here is the load-bearing line that compiles the
     // `@import "tailwindcss"` in storybook.css so token utilities apply.
     viteFinal: (viteConfig) => {
       viteConfig.plugins = [...(viteConfig.plugins ?? []), tailwindcss()]
       return viteConfig
     },
   }

   // eslint-disable-next-line no-restricted-syntax -- Storybook requires a default export for its config; the repo applies the same exemption to vite/vitest config files.
   export default config
   ```

3. **(config — storybook.css)** Create `frontend/.storybook/storybook.css`. Tailwind v4 does not auto-scan node_modules, so register BOTH source trees:
   ```css
   @import 'tailwindcss';
   @import '@mythrun/ui/styles.css';

   /* Tailwind v4 scans only what we point it at. Register BOTH the design-system
      source (token utilities used in component stories) and the app-shell source
      (utilities used in screens + the gate's demo wrappers). */
   @source "../ui/src";
   @source "../src";
   ```

4. **(config — preview.tsx)** Create `frontend/.storybook/preview.tsx`. Keeps the theme toolbar; the padding decorator is **screen-aware** (component specimens get `p-6` tagged `data-sb-pad`; `layout:'fullscreen'` screens render edge-to-edge); fonts are imported so screens lay out at true intrinsic widths:
   ```tsx
   import { useEffect } from 'react'
   import type { Preview } from '@storybook/react-vite'
   import '@fontsource/source-serif-4/400.css'
   import '@fontsource/source-serif-4/600.css'
   import '@fontsource/ibm-plex-mono/400.css'
   import '@fontsource/ibm-plex-mono/500.css'
   import './storybook.css'

   const preview: Preview = {
     parameters: {
       // Component specimens run axe (flag violations). Screen stories override
       // with a11y:{test:'off'} — a11y is out of scope for MYT-97 (overflow-only)
       // and screens carry a latent axe backlog the flow tickets own.
       a11y: { test: 'error' },
     },
     globalTypes: {
       theme: {
         description: 'Light / warm-dark theme',
         toolbar: {
           title: 'Theme',
           icon: 'circlehollow',
           items: [
             { value: 'light', title: 'Light' },
             { value: 'dark', title: 'Warm dark' },
           ],
           dynamicTitle: true,
         },
       },
     },
     initialGlobals: { theme: 'light' },
     decorators: [
       (Story, context) => {
         const dark = context.globals.theme === 'dark'
         // Toggle `.dark` on the document root so PORTALED overlays (rendered to
         // document.body, outside this wrapper) inherit the theme too.
         useEffect(() => {
           const root = document.documentElement
           root.classList.toggle('dark', dark)
           return () => {
             root.classList.remove('dark')
           }
         }, [dark])

         // Screens render edge-to-edge (real viewport budget); component specimens
         // get the p-6 breathing room. The `data-sb-pad` hook lets the overflow
         // gate neutralize the specimen padding so a ≤375-but-wide component is
         // measured against the TRUE 375px budget, not 375−48.
         if (context.parameters['layout'] === 'fullscreen') {
           return <Story />
         }
         return (
           <div data-sb-pad className="bg-bg text-ink p-6">
             <Story />
           </div>
         )
       },
     ],
   }

   // eslint-disable-next-line no-restricted-syntax -- Storybook requires a default export for its preview; the repo applies the same exemption to vite/vitest config files.
   export default preview
   ```

5. **(harness)** Create `frontend/src/storybook/screen-harness.tsx`. It mounts the REAL `routes` array at a seeded entry through the real provider stack with a seeded session + seeded suspense cache, and exposes `expectScreen` (a `play` that asserts the screen's root testid so a non-render / suspense-hang fails LOUD):
   ```tsx
   import { useState } from 'react'
   import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
   import { I18nextProvider } from 'react-i18next'
   import { createMemoryRouter, RouterProvider } from 'react-router-dom'
   import { within, expect } from 'storybook/test'
   import {
     ApiClientProvider,
     useSessionStore,
     type ApiContext,
     type CampaignSummary,
   } from '@mythrun/client-core'
   import { defaultNS } from '@mythrun/client-core/i18n'
   import { routes } from '../app/router.tsx'
   import { i18n } from '../i18n/config.ts'

   // Router-bearing screen harness (MYT-97 §5). Screen stories render the REAL
   // route tree at a seeded entry so the COMPOSITION layer (where the app-frame
   // header bug lived) is gated, not just isolated primitives. The data the
   // screens read is pre-seeded:
   //   • session store → `ready` (the RequireAuth gate), so authed screens render.
   //   • QueryClient cache → setQueryData(['campaigns','mine'], …) with
   //     staleTime:Infinity. `useMyCampaigns` is a SUSPENSE query — a key/shape
   //     mismatch hangs forever, so the story's `play` (expectScreen) asserts the
   //     root testid and fails loud instead of timing out as a flake.
   //   • i18nOverrides → swap an i18n placeholder for adversarial-length copy
   //     (the app-frame display name is an i18n key, not a prop).
   // A dummy ApiContext + the pre-seeded, never-stale cache mean no network call
   // fires. Runs in real Chromium under the test-runner, so RR7's data router
   // works without the jsdom-native-fetch shim the vitest env needs.

   const STORYBOOK_CTX: ApiContext = {
     baseUrl: 'http://storybook.invalid',
     getAuthHeaders: () => Promise.resolve({}),
   }

   type Session = 'unauthenticated' | 'onboarding-required' | 'ready'

   export interface ScreenHarnessProps {
     /** The MemoryRouter entry to render (with seeded :params), e.g. `/home`. */
     readonly entry: string
     /** Seeded session status for the RequireAuth gate. Default `ready`. */
     readonly session?: Session
     /** Pre-seed the `['campaigns','mine']` suspense cache (home hub). */
     readonly seedCampaigns?: readonly CampaignSummary[]
     /** Override i18n keys (e.g. an adversarial-length `frame.displayName`). */
     readonly i18nOverrides?: Readonly<Record<string, string>>
   }

   function seedSession(session: Session): void {
     const store = useSessionStore.getState()
     if (session === 'ready') store.setReady('dev-user-1')
     else if (session === 'onboarding-required') store.setOnboardingRequired('dev-user-1')
     else store.setUnauthenticated()
   }

   export function ScreenHarness({
     entry,
     session = 'ready',
     seedCampaigns,
     i18nOverrides,
   }: ScreenHarnessProps): React.JSX.Element {
     // Lazy init: one-time per story mount, before children render, so the auth
     // gate + suspense query read the seeded state on the first paint.
     const [{ client, router }] = useState(() => {
       if (i18nOverrides) {
         for (const [key, value] of Object.entries(i18nOverrides)) {
           i18n.addResource('en', defaultNS, key, value)
         }
       }
       seedSession(session)
       const queryClient = new QueryClient({
         defaultOptions: {
           queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
         },
       })
       if (seedCampaigns) {
         queryClient.setQueryData(['campaigns', 'mine'], { campaigns: seedCampaigns })
       }
       return { client: queryClient, router: createMemoryRouter(routes, { initialEntries: [entry] }) }
     })

     return (
       <QueryClientProvider client={client}>
         <ApiClientProvider value={STORYBOOK_CTX}>
           <I18nextProvider i18n={i18n}>
             <RouterProvider router={router} />
           </I18nextProvider>
         </ApiClientProvider>
       </QueryClientProvider>
     )
   }

   /**
    * A CSF `play` that asserts the screen's root testid is present — so a
    * non-render (e.g. a suspense-hang from a bad seed shape) fails LOUD, not as a
    * silent timeout-flake.
    */
   export function expectScreen(testid: string) {
     return async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
       await expect(await within(canvasElement).findByTestId(testid)).toBeInTheDocument()
     }
   }
   ```
   If `react-hooks` / a purity lint flags the store mutation inside the `useState` initializer, scope a single `// eslint-disable-next-line` with the justification "one-time story-harness seed before first paint; the home.test.tsx equivalent seeds via act() before render." Verify against the real lint run in step 9 before adding any disable.

6. **(tsconfig)** In `frontend/tsconfig.json`, add `.storybook/**/*` to `include` (so the new config + `test-runner.ts` from Task 8 are strict-typechecked, mirroring `frontend/ui/tsconfig.json`):
   ```jsonc
   "include": ["src/**/*", "vite.config.ts", "vitest.config.ts", "test/**/*", "eslint-rules/**/*", ".storybook/**/*"]
   ```

7. **(eslint ignore)** In `frontend/eslint.config.js`, add to the `ignores` array (near line 148, beside `ui/storybook-static/**`):
   ```js
       'storybook-static/**', // web Storybook build output (gitignored artifact) — never lint it
   ```
   (`.storybook/**` is a dot-dir already auto-skipped by `eslint .`; no extra ignore needed for it.)

8. **(retire ui Storybook)** Delete `frontend/ui/.storybook/main.ts`, `preview.tsx`, `storybook.css`. Remove the `"storybook"` and `"build-storybook"` scripts from `frontend/ui/package.json` (keep `story-coverage`, `test`, `test:coverage`, etc.). Move `@storybook/addon-a11y` / `@storybook/react-vite` / `storybook` to web if pnpm dedupe leaves them unused in ui — but leaving them as ui devDeps is harmless; do NOT remove `@tailwindcss/vite`/`@storybook/react-vite` from ui if any ui tooling still references them. Add `frontend/storybook-static/` to the root `.gitignore`.

9. **(verify)** Run, in order:
   - `pnpm --filter @mythrun/web typecheck` → no errors (proves `.storybook/` + harness type-check).
   - `pnpm --filter @mythrun/web lint` → no errors.
   - `pnpm --filter @mythrun/web build-storybook` → builds to `frontend/storybook-static/`, exit 0, both ui + (currently zero) web stories indexed. Expect a "Storybook X.Y.Z … built" success line and no missing-token/unstyled warnings.
   - `pnpm --filter @mythrun/ui story-coverage` → still passes (component coverage unaffected).

10. **(commit)** `feat(MYT-97): frontend-level Storybook (ui + web) + screen harness`. **Do not push.**

---

## Task 7 — Screen-story-coverage forcing function

**Files:**
- Create `frontend/scripts/screen-story-coverage.mjs` (~50 lines).
- Create `frontend/scripts/screen-story-coverage.test.ts` (~70 lines).

**Interfaces:**
- Produces `findScreensWithoutStories(srcDir)` → `string[]` of screens lacking a co-located `*.stories.tsx`; CLI exits 1 with the offender list.
- The file-vs-directory discriminator (review Ebb-I5): routes are **flat files** (`src/routes/home.tsx`), so the gate looks for a sibling `home.stories.tsx`, not a directory.

**Steps:**

1. **(test, red)** Create `frontend/scripts/screen-story-coverage.test.ts`, mirroring `frontend/ui/scripts/story-coverage.test.ts`'s throwaway-fixture style. It builds a fake `src/` with `routes/` + `app/` and asserts the discriminator:
   ```ts
   import { describe, it, expect, beforeEach, afterEach } from 'vitest'
   import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
   import { tmpdir } from 'node:os'
   import { join } from 'node:path'
   import { findScreensWithoutStories } from './screen-story-coverage.mjs'

   // findScreensWithoutStories(srcDir) requires a co-located *.stories.tsx for
   // every flat src/routes/*.tsx screen + the enumerated app screens
   // (app-frame, not-found). Driven against fixture trees so the discriminator is
   // pinned without depending on the real (evolving) screen set.

   describe('findScreensWithoutStories', () => {
     let src: string

     beforeEach(() => {
       src = mkdtempSync(join(tmpdir(), 'screen-coverage-'))
       mkdirSync(join(src, 'routes'), { recursive: true })
       mkdirSync(join(src, 'app'), { recursive: true })
       // The enumerated app screens exist with stories by default; tests below
       // remove pieces to assert the gate.
       for (const base of ['app-frame', 'not-found']) {
         writeFileSync(join(src, 'app', `${base}.tsx`), 'export const X = () => null\n')
         writeFileSync(join(src, 'app', `${base}.stories.tsx`), 'export default {}\n')
       }
     })
     afterEach(() => {
       rmSync(src, { recursive: true, force: true })
     })

     it('passes a route file that has a co-located story', () => {
       writeFileSync(join(src, 'routes', 'home.tsx'), 'export const HomeRoute = () => null\n')
       writeFileSync(join(src, 'routes', 'home.stories.tsx'), 'export default {}\n')
       expect(findScreensWithoutStories(src)).toEqual([])
     })

     it('reports a route file that lacks a story', () => {
       writeFileSync(join(src, 'routes', 'settings.tsx'), 'export const SettingsRoute = () => null\n')
       expect(findScreensWithoutStories(src)).toEqual(['src/routes/settings.tsx'])
     })

     it('ignores *.test.tsx and *.stories.tsx themselves (not screens)', () => {
       writeFileSync(join(src, 'routes', 'home.tsx'), 'export const HomeRoute = () => null\n')
       writeFileSync(join(src, 'routes', 'home.stories.tsx'), 'export default {}\n')
       writeFileSync(join(src, 'routes', 'home.test.tsx'), 'export {}\n')
       expect(findScreensWithoutStories(src)).toEqual([])
     })

     it('reports an enumerated app screen missing its story', () => {
       rmSync(join(src, 'app', 'not-found.stories.tsx'))
       expect(findScreensWithoutStories(src)).toEqual(['src/app/not-found.tsx'])
     })

     it('does NOT require a story for non-screen app infra (router, providers)', () => {
       writeFileSync(join(src, 'app', 'router.tsx'), 'export const routes = []\n')
       writeFileSync(join(src, 'app', 'providers.tsx'), 'export const AppProviders = () => null\n')
       expect(findScreensWithoutStories(src)).toEqual([])
     })
   })
   ```
   Run `pnpm --filter @mythrun/web test screen-story-coverage` → **fails** (module not found). TDD red.

2. **(impl)** Create `frontend/scripts/screen-story-coverage.mjs`:
   ```js
   // Screen-story-coverage gate (MYT-97 §5). The component story-coverage gate
   // globs DIRECTORIES under ui/src/components — it cannot see the app shell's
   // FLAT screen files. This gate requires a co-located *.stories.tsx for every
   // player-facing screen so the 375/1280 overflow gate actually measures it:
   //   • every flat src/routes/*.tsx (each is a screen), and
   //   • the enumerated assembled app screens (the frame + the 404). Other app/
   //     files (providers, router, require-auth, error-boundary) are
   //     infrastructure, not navigable screens, and are exempt by construction.
   //
   // Exit 1 (offender list printed) if any screen lacks a story; exit 0 otherwise.

   import { readdirSync, existsSync } from 'node:fs'
   import { dirname, join, resolve } from 'node:path'
   import { fileURLToPath } from 'node:url'

   const DEFAULT_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
   const APP_SCREENS = ['app-frame', 'not-found']

   /**
    * @param {string} srcDir absolute path to the frontend `src/` dir
    * @returns {string[]} screen paths (repo-relative-ish) lacking a co-located story
    */
   export function findScreensWithoutStories(srcDir = DEFAULT_SRC) {
     const routesDir = join(srcDir, 'routes')
     const appDir = join(srcDir, 'app')
     const offenders = []

     let routeEntries = []
     try {
       routeEntries = readdirSync(routesDir)
     } catch {
       routeEntries = []
     }
     const routeScreens = routeEntries.filter(
       (f) => f.endsWith('.tsx') && !f.endsWith('.stories.tsx') && !f.endsWith('.test.tsx'),
     )
     for (const file of routeScreens) {
       const base = file.replace(/\.tsx$/, '')
       if (!existsSync(join(routesDir, `${base}.stories.tsx`))) {
         offenders.push(`src/routes/${file}`)
       }
     }

     for (const base of APP_SCREENS) {
       if (!existsSync(join(appDir, `${base}.stories.tsx`))) {
         offenders.push(`src/app/${base}.tsx`)
       }
     }
     return offenders
   }

   function main() {
     const offenders = findScreensWithoutStories()
     if (offenders.length > 0) {
       console.error('Screen-story-coverage gate failed. These screens lack a co-located *.stories.tsx:')
       for (const f of offenders) console.error(`  - ${f}`)
       console.error(
         '\nEvery screen (routes/* + the assembled app screens) must ship a Storybook story so the 375/1280 overflow gate measures it.',
       )
       process.exit(1)
     }
     console.log('Screen-story-coverage gate passed.')
   }

   if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
     main()
   }
   ```

3. **(verify)** `pnpm --filter @mythrun/web test screen-story-coverage` → 5 tests pass. (Do **not** run the CLI against the real tree yet — screens have no stories until Tasks 10/11; the CLI is wired into CI in Task 12.)

4. **(commit)** `feat(MYT-97): screen-story-coverage gate (routes + app screens)`. **Do not push.**

---

## Task 8 — The overflow gate (`postVisit`) + local canary smoke

**Files:**
- Create `frontend/.storybook/test-runner.ts` (~70 lines).

**Interfaces:**
- Consumes `TestRunnerConfig` from `@storybook/test-runner` (the `page` param is a typed Playwright `Page`).
- Reads per-story `parameters.overflowGate` (`false` → skip; `{ openSelector }` → assert portal then measure).
- Produces: a story-level failure when `max(#storybook-root, body).scrollWidth > window.innerWidth + 1` at 375 or 1280.

**Steps:**

1. **(impl)** Create `frontend/.storybook/test-runner.ts`. The hook throws (no jest `expect` dependency → clean tsc with only `@storybook/test-runner` installed):
   ```ts
   import type { TestRunnerConfig } from '@storybook/test-runner'

   // The mobile-viewport overflow gate (MYT-97 §5). For EVERY story this hook
   // renders in real Chromium (the test-runner is Playwright-backed), sets the
   // viewport to 375px then 1280px (--breakpoint-xl), and fails the story if its
   // rendered width exceeds the true viewport. Outcome-based: it does not care HOW
   // a component fits (intrinsic shrink OR breakpoint collapse) — only that
   // nothing scrolls sideways.
   //
   // Calibration (review I1/I2):
   //   • Baseline is window.innerWidth (includes the scrollbar gutter), NOT
   //     documentElement.clientWidth — clientWidth excludes the gutter and
   //     false-fails vw-sized overlays (Modal w-[min(92vw,…)], Toast).
   //   • We measure max(#storybook-root, document.body).scrollWidth. Portaled
   //     overlays render to document.body OUTSIDE #storybook-root; body ⊇ root, and
   //     with layout:'fullscreen' body carries no extra chrome, so this never
   //     under-reports and uniquely catches overlay overflow (the spec's
   //     "measure the root, not clientWidth" intent, generalized to portals).
   //   • +1px tolerance absorbs sub-pixel rounding.
   //   • [data-sb-pad] padding is zeroed so a ≤375-but-wide component is measured
   //     against the TRUE 375px budget, not 375−48.
   //   • A rAF×2 + 50ms settle precedes each measurement (entrance transitions).
   //
   // Per-story controls (parameters.overflowGate):
   //   • false             → skip (sanctioned wide-by-design specimens, e.g. Grid).
   //   • { openSelector }  → assert the portal is attached before measuring, so an
   //     overlay that silently failed to open fails LOUD, not as an empty root.

   const WIDTHS = [375, 1280] as const

   type OverflowGateParam = false | { openSelector?: string } | undefined

   const config: TestRunnerConfig = {
     async postVisit(page, context) {
       const gate = context.parameters['overflowGate'] as OverflowGateParam
       if (gate === false) return

       // Neutralize specimen padding so the budget is the true viewport.
       await page.addStyleTag({ content: '[data-sb-pad]{padding:0 !important}' })

       // Overlay stories must be OPEN: wait for the portal, fail loud if absent.
       const openSelector = gate && typeof gate === 'object' ? gate.openSelector : undefined
       if (openSelector) {
         await page.waitForSelector(openSelector, { state: 'attached', timeout: 5000 })
       }

       for (const width of WIDTHS) {
         await page.setViewportSize({ width, height: 900 })
         await page.evaluate(
           () =>
             new Promise<void>((resolve) => {
               requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
             }),
         )
         await page.waitForTimeout(50)

         const { maxScroll, innerWidth } = await page.evaluate(() => {
           const root = document.querySelector('#storybook-root')
           const candidates = [root, document.body].filter((el): el is Element => el !== null)
           const max = Math.max(...candidates.map((el) => el.scrollWidth))
           return { maxScroll: max, innerWidth: window.innerWidth }
         })

         if (maxScroll > innerWidth + 1) {
           throw new Error(
             `[overflow-gate] "${context.title} / ${context.name}" overflows at ${String(width)}px: ` +
               `content scrollWidth ${String(maxScroll)} > viewport ${String(innerWidth)} (+1px tolerance). ` +
               `Give shrinkable content intrinsic shrink (Stack min-w-0 child / Text truncate / Stack wrap), ` +
               `fixed affordances shrink-0, or use a breakpoint collapse.`,
           )
         }
       }
     },
   }

   // eslint-disable-next-line no-restricted-syntax -- the test-runner consumes its config as a default export (tool-config carve-out, like vite/vitest config).
   export default config
   ```

2. **(verify type)** `pnpm --filter @mythrun/web typecheck` → no errors (proves `TestRunnerConfig` + Playwright `Page` resolve).

3. **(canary smoke — gate goes RED on real overflow, then GREEN)** This is the required real end-to-end smoke (CLAUDE.md: a new gate capability gets a real E2E smoke before hand-off — type-check is not enough):
   - Install the browser once: `pnpm --filter @mythrun/web exec playwright install chromium`.
   - Add a **temporary** canary story `frontend/ui/src/components/Stack/Stack.canary.stories.tsx` that deliberately overflows:
     ```tsx
     import type { Meta, StoryObj } from '@storybook/react-vite'
     import { Stack } from './Stack.tsx'

     const meta: Meta<typeof Stack> = { title: 'Canary/Overflow', component: Stack }
     // eslint-disable-next-line no-restricted-syntax -- CSF meta default export.
     export default meta
     type Story = StoryObj<typeof Stack>

     export const Overflows: Story = {
       render: () => <div className="w-[2000px] h-4 bg-accent" />,
     }
     ```
   - `pnpm --filter @mythrun/web build-storybook && pnpm --filter @mythrun/web test-storybook:ci` → expect the run to **FAIL** with `[overflow-gate] "Canary/Overflow / Overflows" overflows at 375px: content scrollWidth 2000 > viewport 375`. This proves the gate actually catches overflow (not a green no-op).
   - Add `parameters: { overflowGate: false }` to the canary story and re-run → the canary is now **skipped** (proves the opt-out path). 
   - **Delete the canary story file.** Re-run `build-storybook && test-storybook:ci` → the remaining ui component stories' result is recorded for Task 9 (overlays/wide stories may still be red — that's Task 9's job).

4. **(commit)** `feat(MYT-97): test-runner overflow gate (375/1280) + opt-out + open-overlay`. **Do not push.** (The canary file is NOT committed — it was deleted.)

---

## Task 9 — Make the component (ui) gate green: open-overlay stories + wide-by-design opt-outs

**Files:**
- Modify the open story of each overlay (add `parameters.overflowGate.openSelector` + ensure open state): `frontend/ui/src/components/{Modal,Menu,Popover,Select,Tooltip,Toast}/*.stories.tsx`.
- Modify `frontend/ui/src/components/Grid/Grid.stories.tsx` (line ~51, the `w-[480px]` story) and `frontend/ui/src/components/Dither/Dither.stories.tsx` (line ~123, the `w-[28rem]` story): add `parameters: { overflowGate: false }`.
- Modify any OTHER ui story the Task 8 run flagged (audit-driven).

**Interfaces:** Consumes the gate's `parameters.overflowGate` contract from Task 8.

**Steps:**

1. **(audit)** From Task 8's final `test-storybook:ci` run, list every red ui story. Also `grep -rn 'w-\[' frontend/ui/src/components/*/*.stories.tsx | grep -v max-w` to find wide-by-design specimens (known: `Grid.stories` `w-[480px]`, `Dither.stories` `w-[28rem]`).

2. **(wide-by-design opt-out)** For each intentionally-wide specimen story (Grid, Dither, and any other the audit surfaces), add:
   ```tsx
     parameters: { overflowGate: false },
   ```
   to that Story object, and convert any new demo wrappers to `max-w-full` (the sanctioned convention). Do **not** opt out a story that overflows due to a real primitive defect — fix the primitive/story instead.

3. **(overlay open + portal assertion)** For each of the 6 overlays, ensure at least ONE story renders the overlay **open** (a controlled `open`/`defaultOpen` arg, or a `play` that activates the trigger and awaits the portal) and tag it with the portal selector so the gate measures it and fails loud if it didn't open. Suggested selectors (the implementer **verifies each against the rendered DOM** — open the story in `pnpm --filter @mythrun/web storybook` and inspect):
   - Modal (Radix Dialog): `parameters: { overflowGate: { openSelector: '[role="dialog"]' } }`
   - Menu (Radix DropdownMenu): `[role="menu"]`
   - Select (Radix Select): `[role="listbox"]`
   - Popover (Radix Popover): `[data-radix-popper-content-wrapper]`
   - Tooltip (Radix Tooltip): `[role="tooltip"]`
   - Toast (custom `toast()` + `ToastProvider`): `[role="status"]`
   Closed-trigger-only overlay stories render a near-empty root and pass trivially — no opt-out needed.

4. **(verify)** `pnpm --filter @mythrun/web build-storybook && pnpm --filter @mythrun/web test-storybook:ci` → **all component (ui) stories green** at 375 and 1280. Expect a passing summary (no `[overflow-gate]` throws). If a real overflow remains in a component beyond the 4 changed primitives, fix it intrinsically (per §4: "the gate lights up the ones that actually overflow; those get fixed") and note it.

5. **(visual pass — squish net, §4)** The overflow boolean is blind to squish/overlap/over-truncation. Open `pnpm --filter @mythrun/web storybook`, switch the viewport to 375px, and eyeball the changed primitives' demo stories + a sampling of overlays for squish/overlap. This pairs the regression-proof overflow net with the squish net (the standing "visually audit UI before push" rule). Record observations; fix any squish intrinsically.

6. **(commit)** `feat(MYT-97): overlay-open gate stories + wide-by-design opt-outs (ui green)`. **Do not push.**

---

## Task 10 — Screen stories (routes + 404 + home), gate-green

**Files (create one `*.stories.tsx` per screen):**
- `frontend/src/routes/{landing,signin,callback,onboard,join,recap,home,campaign-new,character-new,play,settings}.stories.tsx`
- `frontend/src/app/not-found.stories.tsx`

(The app-frame story + its header fix are Task 11.)

**Interfaces:** Consumes `ScreenHarness`, `expectScreen` (Task 6). Each story sets `parameters: { layout: 'fullscreen', a11y: { test: 'off' } }` and a `play: expectScreen('<root-testid>')`.

**Steps:**

1. **(home — adversarial-length, the MYT-83 class)** Create `frontend/src/routes/home.stories.tsx`. Seed worst-case-length campaign titles so intrinsic shrink is actually under test (a short `"Bob"` seed would pass at 375 yet overflow in prod):
   ```tsx
   import type { Meta, StoryObj } from '@storybook/react-vite'
   import type { CampaignSummary } from '@mythrun/client-core'
   import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

   const meta: Meta<typeof ScreenHarness> = {
     title: 'Screens/Home',
     component: ScreenHarness,
     parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
   }
   // eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
   export default meta
   type Story = StoryObj<typeof ScreenHarness>

   const LONG_CAMPAIGNS: readonly CampaignSummary[] = [
     {
       id: 'c-1',
       worldId: 'w-1',
       name: 'The Interminable Saga of the Drowned Cathedral and Its Thousand Sunken Bells',
       status: 'active',
       language: 'en',
       createdAt: '2026-06-24T10:00:00.000Z',
       updatedAt: '2026-06-24T11:00:00.000Z',
     },
     {
       id: 'c-2',
       worldId: 'w-2',
       name: 'Ashfall Reach and the Long Road Through the Cinderlands Beyond the Edge of the Map',
       status: 'setup',
       language: 'en',
       createdAt: '2026-06-24T12:00:00.000Z',
       updatedAt: '2026-06-24T13:00:00.000Z',
     },
   ]

   export const LongCampaignTitles: Story = {
     name: 'Home · long campaign titles',
     render: () => <ScreenHarness entry="/home" session="ready" seedCampaigns={LONG_CAMPAIGNS} />,
     play: expectScreen('route-home'),
   }
   ```

2. **(404)** Create `frontend/src/app/not-found.stories.tsx`:
   ```tsx
   import type { Meta, StoryObj } from '@storybook/react-vite'
   import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

   const meta: Meta<typeof ScreenHarness> = {
     title: 'Screens/NotFound',
     component: ScreenHarness,
     parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
   }
   // eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
   export default meta
   type Story = StoryObj<typeof ScreenHarness>

   export const Dithered: Story = {
     name: '404 · dithered dead end',
     render: () => <ScreenHarness entry="/no-such-path" session="ready" />,
     play: expectScreen('not-found'),
   }
   ```

3. **(public + authed stubs)** Create one minimal story per remaining screen, each `render`ing `ScreenHarness` at the right entry with seeded `:params` and the right session, and a `play` asserting the route testid. Entries + sessions + testids:
   | story file | entry | session | root testid |
   |---|---|---|---|
   | `routes/landing.stories.tsx` | `/` | `ready` | `route-landing` |
   | `routes/signin.stories.tsx` | `/auth/signin` | `unauthenticated` | `route-signin` |
   | `routes/callback.stories.tsx` | `/auth/callback/google` | `unauthenticated` | `route-callback` |
   | `routes/onboard.stories.tsx` | `/auth/onboard` | `onboarding-required` | `route-onboard` |
   | `routes/join.stories.tsx` | `/join/SAMPLE-CODE` | `ready` | `route-join` |
   | `routes/recap.stories.tsx` | `/campaigns/c-1/recap` | `ready` | `route-recap` |
   | `routes/campaign-new.stories.tsx` | `/campaigns/new` | `ready` | `route-campaign-new` |
   | `routes/character-new.stories.tsx` | `/campaigns/c-1/character/new` | `ready` | `route-character-new` |
   | `routes/play.stories.tsx` | `/campaigns/c-1/play` | `ready` | `route-play` |
   | `routes/settings.stories.tsx` | `/settings` | `ready` | `route-settings` |

   Each file follows this exact shape (example `routes/settings.stories.tsx`):
   ```tsx
   import type { Meta, StoryObj } from '@storybook/react-vite'
   import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

   const meta: Meta<typeof ScreenHarness> = {
     title: 'Screens/Settings',
     component: ScreenHarness,
     parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
   }
   // eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
   export default meta
   type Story = StoryObj<typeof ScreenHarness>

   export const Default: Story = {
     render: () => <ScreenHarness entry="/settings" session="ready" />,
     play: expectScreen('route-settings'),
   }
   ```

4. **(verify)**
   - `pnpm --filter @mythrun/web typecheck && pnpm --filter @mythrun/web lint` → no errors. The routes stories import only `@storybook/react-vite` (type-only), the harness (relative), and `@mythrun/client-core` types — none tripping the `src/routes/**` import boundary (no `@tanstack/react-query`, no deep `@mythrun/client-core/src/*`, no web globals).
   - `pnpm --filter @mythrun/web build-storybook && pnpm --filter @mythrun/web test-storybook:ci` → **all screen stories green at 375 + 1280**, each `play` finding its root testid (proves the seeded suspense cache resolved — no hang).
   - `pnpm --filter @mythrun/web screen-story-coverage` → still reports `src/app/app-frame.tsx` missing (expected — Task 11 adds it). Do not treat as a failure of this task.

5. **(commit)** `feat(MYT-97): seeded screen stories (routes + 404 + home), gate-green`. **Do not push.**

---

## Task 11 — The header fix (app-frame truncation), red→green via its adversarial story

**Files:**
- Create `frontend/src/app/app-frame.stories.tsx` (the adversarial-long-display-name story).
- Modify `frontend/src/app/app-frame.tsx` (add `truncate` to the identity Text, lines 28–30).

**Interfaces:** Consumes `Text.truncate` (Task 2) + `Stack` `min-w-0` (Task 1) + `Button` `shrink-0` (Task 3). Reproduces the MYT-83 header overflow at 375px, then fixes it.

**Steps:**

1. **(story, red)** Create `frontend/src/app/app-frame.stories.tsx`. It mounts a minimal authed child (`/settings`) so the header is the focus, and overrides the `frame.displayName` i18n placeholder with an adversarial-long real-world display name:
   ```tsx
   import type { Meta, StoryObj } from '@storybook/react-vite'
   import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

   const meta: Meta<typeof ScreenHarness> = {
     title: 'Screens/AppFrame',
     component: ScreenHarness,
     parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
   }
   // eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
   export default meta
   type Story = StoryObj<typeof ScreenHarness>

   // The MYT-83 bug class: a long display name shoved the settings affordance off
   // the right edge at 375px. The header must truncate to a single quiet row.
   export const LongDisplayName: Story = {
     name: 'App frame · long display name truncates',
     render: () => (
       <ScreenHarness
         entry="/settings"
         session="ready"
         i18nOverrides={{
           'frame.displayName': 'Aldebaran Featherstonehaugh-Wintermoor, Keeper of the Long Unbroken Title',
         }}
       />
     ),
     play: expectScreen('app-frame'),
   }
   ```
   Run `pnpm --filter @mythrun/web build-storybook && pnpm --filter @mythrun/web test-storybook:ci` → this story **FAILS** at 375px (`[overflow-gate] "Screens/AppFrame / App frame · long display name truncates" overflows at 375px`). This is the TDD red that locks in the fix.

2. **(fix)** In `app-frame.tsx`, give the identity display-name `Text` the `truncate` prop (the `Stack` children already shrink via the new `[&>*]:min-w-0`; the settings `Button` already holds its size via `shrink-0`). Change lines 28–30:
   ```tsx
             <Text role="ui-label" truncate data-testid="frame-display-name">
               {t('frame.displayName')}
             </Text>
   ```
   Update the component's header comment to note the responsiveness contract (one line, after line 15):
   ```tsx
   // Responsiveness (MYT-97): the header truncates to a single quiet row — the
   // display-name Text ellipsizes (truncate), the Stack children shrink (min-w-0),
   // the settings Button holds its size (shrink-0) — so a long display name never
   // shoves the affordance off-screen at 375px.
   ```

3. **(verify)**
   - `pnpm --filter @mythrun/web build-storybook && pnpm --filter @mythrun/web test-storybook:ci` → the app-frame story (and ALL stories) **green** at 375 + 1280.
   - `pnpm --filter @mythrun/web screen-story-coverage` → now **passes** (app-frame story present).
   - `pnpm --filter @mythrun/web typecheck && pnpm --filter @mythrun/web lint && pnpm --filter @mythrun/web test` → all green.
   - Confirm the existing `frontend/src/app/router.test.tsx` + `frontend/src/routes/home.test.tsx` still pass (the `app-frame` / `route-home` testids are unchanged).
   - **Visual 375px pass:** open `pnpm --filter @mythrun/web storybook`, view `Screens/AppFrame · long display name`, confirm the name ellipsizes into one row with the settings button intact and no sideways scroll.

4. **(commit)** `fix(MYT-97): app-frame header truncates a long display name (375px)`. **Do not push.**

---

## Task 12 — CI + pre-push wiring (CI-only overflow sweep)

**Files:**
- Modify `.github/workflows/frontend-check.yml` (timeout, Playwright cache + install, build + run gate + screen-coverage; drop the ui `build-storybook` step).
- Modify `.husky/pre-push` (swap the ui `build-storybook` for the web one + screen-coverage; keep the overflow sweep CI-only).

**Interfaces:** Wires Tasks 7 + 8 into the gates. Leans CI-only for the Playwright sweep ("pushes are expensive").

**Steps:**

1. **(CI)** In `frontend-check.yml`:
   - Raise `timeout-minutes: 8` → `timeout-minutes: 15`.
   - After the `pnpm install` step, add a Playwright browser cache:
     ```yaml
     - uses: actions/cache@... # pin the repo's standard actions/cache SHA
       with:
         path: ~/.cache/ms-playwright
         key: playwright-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
     ```
   - In the `@mythrun/ui` block, **remove** `- run: pnpm --filter @mythrun/ui build-storybook` (the ui no longer owns a Storybook). Keep `- run: pnpm --filter @mythrun/ui story-coverage`.
   - In the `@mythrun/web` block, after `- run: pnpm --filter @mythrun/web build` add the gate steps:
     ```yaml
     # Screen-story-coverage forcing function (every screen ships a story).
     - run: pnpm --filter @mythrun/web screen-story-coverage
     # The 375/1280 mobile-viewport overflow gate (Playwright/Chromium). Build the
     # unified Storybook once, then run the test-runner sweep against the static
     # build. Browser is cached above; --with-deps installs OS libs on a cache miss.
     - run: pnpm --filter @mythrun/web exec playwright install --with-deps chromium
     - run: pnpm --filter @mythrun/web build-storybook
     - run: pnpm --filter @mythrun/web test-storybook:ci
     ```

2. **(pre-push)** In `.husky/pre-push`, inside the frontend block (lines ~92–108): replace `pnpm --filter @mythrun/ui build-storybook` with the web build + screen-coverage, and add a comment that the overflow sweep is CI-only:
   ```sh
     pnpm --filter @mythrun/ui story-coverage
     pnpm --filter @mythrun/web screen-story-coverage
     # build-storybook catches story/MDX breakage cheaply; the Playwright overflow
     # sweep (test-storybook) is CI-only — too slow + heavy for pre-push (pushes
     # are expensive). frontend-check.yml runs the full 375/1280 gate.
     pnpm --filter @mythrun/web build-storybook
     pnpm --filter @mythrun/web typecheck
     pnpm --filter @mythrun/web lint
     pnpm --filter @mythrun/web test
     pnpm --filter @mythrun/web test:coverage
     pnpm --filter @mythrun/web build
   ```
   (Keep the existing client-core + ui typecheck/lint/test/coverage lines above; only the storybook line changes + the screen-coverage line is added.)

3. **(verify)** Dry-run the changed gate steps locally:
   - `pnpm --filter @mythrun/web screen-story-coverage` → pass.
   - `pnpm --filter @mythrun/web build-storybook` → success.
   - `pnpm --filter @mythrun/web test-storybook:ci` → all stories green at 375 + 1280.
   - Lint the workflow YAML mentally for indentation; confirm the `actions/cache` SHA matches the repo's pinned standard (grep other workflows for the cache action SHA).

4. **(commit)** `ci(MYT-97): frontend-check overflow gate + screen-coverage; pre-push CI-only sweep`. **Do not push.** (The controller runs the full close-out: wiki subagent → single `git push` → Linear Done, per the workflow.)

---

## Spec-coverage self-review (every §3–§9 decision → a task)

| Spec decision | Task |
|---|---|
| §3 intrinsic-first recipe (`min-w-0` necessary-not-sufficient; child wraps/truncates; fixed affordances `shrink-0`) | 1, 2, 3, 4 |
| §3 native is re-implementation behind the same prop (Yoga shrink, `numberOfLines`) | 1, 2 (doc-comments) |
| §3 breakpoints permitted + `@platform-divergent: breakpoint` marker, unlinted | Global Constraints (no breakpoint used this ticket; convention in force) |
| §3 gate is outcome-based (overflow, mechanism-agnostic) | 8 |
| §4 Stack `[&>*]:min-w-0` + `wrap` | 1 |
| §4 Text `truncate` (`overflow-hidden text-ellipsis whitespace-nowrap`) | 2 |
| §4 Button `shrink-0` (whitespace-nowrap, no overflow-hidden) | 3 |
| §4 bare Icon `shrink-0` | 4 |
| §4 other components not changed speculatively; gate lights up overflows | 9 |
| §4 contract props `Stack.wrap`, `Text.truncate` platform-neutral; `min-w-0`/`shrink-0` impl details | 1, 2 |
| §4 audit is gate-driven AND visual (squish net) | 9 (visual pass), 11 (visual pass) |
| §5 runner = `@storybook/test-runner` (resolved, justified) | Runner decision + 8 |
| §5 assertion: 375 + 1280, `scrollWidth ≤ innerWidth + 1`, not clientWidth, neutralize `p-6`, settle wait | 8 |
| §5 overlays render open + portal asserted before measuring | 9 (stories) + 8 (assertion) |
| §5 router-bearing seeded screen stories (MemoryRouter + seeded params + `setQueryData(['campaigns','mine'])` + session ready + asserted root testid) | 6 (harness) + 10 + 11 |
| §5 adversarial-length content | 10 (home), 11 (app-frame) |
| §5 wide-by-design opt-out (`parameters.overflowGate:false`, `max-w-full`) | 8 (mechanism) + 9 (Grid/Dither) |
| §5 topology: one frontend-level Storybook scanning ui + web (resolved) | Topology decision + 6 |
| §5 screen-specific preview (no `p-6`/`a11y:error` on screens) | 6 |
| §5 screen-story-coverage check (glob `routes/*.tsx` + app screens, file-vs-dir discriminator) | 7 |
| §5 CI wiring (build-storybook once → runner; raise timeout; cache `~/.cache/ms-playwright`; pin+`--with-deps` browser) | 12 |
| §5 pre-push scope decided (CI-only sweep) | 12 |
| §5 a11y out of scope (overflow-only) | 6 (screens `a11y:off`), 8 (no axe in postVisit) |
| §6 header fix (identity Text truncate, Stack shrink, Button shrink-0), locked by adversarial app-frame story red→green | 11 |
| §7 TDD order (primitives + gate first, then audit/header) | Task order 1–12 |
| §8 portability: contract tsc-inherited, behavior a documented native obligation; breakpoint enumeration mechanism | 1, 2 (doc-comments) + Global Constraints |
| §9 done-when (gate green all stories; screen-coverage passes; header no overflow; props exist with stories+tests; CI-wired) | 1–12 cumulative |
| Appendix — `box.ts` `100vh` → `100dvh` comment | 5 |

**Placeholder scan:** no "TBD"/"similar to"/"add error handling" — every code step is complete. **Type/name consistency:** `overflowGate` param name, `data-sb-pad` hook, `ScreenHarness`/`expectScreen`, `findScreensWithoutStories`, `CampaignSummary` shape (`id/worldId/name/status/language/createdAt/updatedAt`), and testids (`app-frame`, `route-home`, `route-*`, `not-found`) are used identically across Tasks 6–12.

## Resolved ambiguities (spec was silent / required a judgment call)

1. **Measure root *or* body?** Spec §5 names `#storybook-root`; overlays portal to `document.body` (a sibling). To catch both without per-story branching, the gate measures `max(#storybook-root, document.body).scrollWidth` vs `window.innerWidth + 1`. `document.body ⊇ #storybook-root`, and `layout:'fullscreen'` strips Storybook's own chrome, so this never under-reports and uniquely captures overlay overflow — faithful to the spec's intent ("measure the root, not clientWidth") generalized to portals.
2. **"Screen decorator" implemented as a render-harness.** The spec calls it a "decorator"; idiomatic CSF for full-screen "page" stories is a `render` harness (so `canvasElement` contains the screen for the `play` assertion). `ScreenHarness` is that harness — functionally the decorator the spec describes.
3. **Adversarial display name injection.** The app-frame display name is the i18n placeholder `frame.displayName` (not a prop), so the adversarial-length seed is an `i18nOverrides` → `i18n.addResource(...)` in the harness. The test-runner reloads the iframe per story, so the override doesn't leak across the gated stories (it would persist within a single manual Storybook session — acceptable for a dev tool).
4. **Gate throws instead of using `expect`.** `postVisit` throws a descriptive `Error` on overflow rather than depending on the test-runner's jest global `expect`, so `frontend/.storybook/test-runner.ts` type-checks cleanly with only `@storybook/test-runner` installed (no `@types/jest` / `@playwright/test` direct dep).
5. **test-runner version ceiling.** SB9 maps to the `>=0.19.0 <0.24.0` line (the `0.24.x` line is SB10-only); Task 8/6 verifies the resolved version via `pnpm why`.
6. **Which `app/` files are screens.** The screen-coverage gate enumerates exactly `app-frame` + `not-found`; `providers`/`router`/`require-auth`/`error-boundary` are infrastructure and exempt by construction.
