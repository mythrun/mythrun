import type { BaseProps } from './index.ts'
import type { SpaceToken } from './space-token.ts'

/**
 * The narrow-viewport full-screen stage (MYT-89 audit v2 — mobile full-bleed).
 *
 * A screen that should OWN the phone (a pannable canvas, an immersive surface)
 * normally renders inside the app's framed chrome: a header bar above and a
 * token-padded content box around it. On a phone-class viewport (< 640px — the
 * DS's one narrow regime) this stage CANCELS the host frame's content inset
 * (negative margins at the same `--space-*` step) and FILLS the viewport below
 * whatever sits above it (the header stays), laying its children out as a flex
 * column so a full-height child (e.g. WorldGenGraph's footer layout) can flex
 * into the space. On a wide viewport it renders a plain block — the wrapped
 * content is laid out exactly as if the stage weren't there.
 *
 * Platform-neutral (§9): `inset` is a token, children are the stage's content.
 * No className/style/DOM events.
 */
export interface FullBleedStageProps extends BaseProps {
  /** The host frame's content inset to cancel on narrow viewports — the SAME
   *  `--space-*` step the frame pads its content box with (the app frame uses
   *  step 6). If the two drift, the stage stops being edge-to-edge. */
  inset: SpaceToken
}
