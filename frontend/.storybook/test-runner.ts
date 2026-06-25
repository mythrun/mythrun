import type { TestRunnerConfig } from '@storybook/test-runner'
import { getStoryContext } from '@storybook/test-runner'

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
    // postVisit's `context` (TestContext) carries only id/title/name; per-story
    // `parameters` live on the full story context, fetched via getStoryContext
    // (@storybook/test-runner@0.23.0 — same pattern as the README a11y example).
    const storyContext = await getStoryContext(page, context)
    const gate = storyContext.parameters.overflowGate as OverflowGateParam
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
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                resolve()
              }),
            )
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
