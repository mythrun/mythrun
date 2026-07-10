import type { BaseProps } from './index.ts'

/**
 * Prose that ARRIVES — the render surface for LLM text streaming in live
 * (myth-umggn: the guided create flow's world brief; later, any streamed
 * narration). Renders `text` in the `prose-body` role, byte-identical in
 * type/metrics to `<Text role="prose-body" as="p">`, so a finished stream
 * hands off to a static Text with zero reflow. While `writing`, a quiet ink
 * caret (a small square — paper register, no circles) sits after the last
 * character and pulses on the brand's sanctioned opacity fade; when `writing`
 * ends the caret leaves. Under reduced motion the caret holds steady (motion
 * is never the only signal — the arriving text itself shows progress).
 *
 * `text` is DATA (the streamed prose), never an i18n key. `children`
 * (inherited from {@link BaseProps}) is unused — the text prop is the content.
 */
export interface StreamingProseProps extends BaseProps {
  /** The prose accumulated so far. */
  text: string
  /** True while more text is arriving — shows the writing caret. Default false. */
  writing?: boolean
  /** Screen-reader annotation for the in-progress state (an i18n key the
   *  consumer resolves). Applied while `writing` so AT hears that the passage
   *  is still being written; silent when finished. */
  writingLabel?: string
}
