import { Stack, Box, Heading, Text, Dither } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The dithered 404 — a FULL-SCREEN DARK dead end, and the brand's stepped Bayer
// Dither in its FIRST product use (brand decisions.md §27: "dithering replaces
// smooth interpolation anywhere a gradient would otherwise appear").
//
// The Dither is a real TRANSITION here, its canonical use (a crossfade between
// two genuinely different-colored sections), NOT decoration: it sits flush at
// the TOP of the page, its `light-ink` pairing grading the cream page-top DOWN
// into the dark reversed surface that fills the rest of the viewport — the band's
// cream top (paper-100 ground) meets the page edge, its ink bottom (paper-900
// accent) resolves seamlessly into the reversed surface's `--bg` (also paper-900)
// below. The headline + body then carry the meaning as light-on-dark text (both
// i18n placeholders the copy pass fills).
//
// Composed from @mythrun/ui primitives only (R5, no-ad-hoc-ui): the root is a
// reversed (dark) Box floored to the full viewport (`minHeight="screen"`), so the
// dark surface covers the whole screen with no cream below the band. The W3c
// router test asserts the Dither's `data-dither-texture` renders for an unknown
// path.
export function NotFound(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Box surface="reversed" minHeight="screen" data-testid="not-found">
      <Stack align="stretch" gap={8}>
        <Dither pairing="light-ink" data-testid="not-found-dither" />
        {/* The content region carries only padding — `surface="reversed"` keeps it
            the SAME uniform dark paper-900 as the root (a base surface would paint
            the lighter paper-800 panel tone and break the single-tone dark field). */}
        <Box surface="reversed" padding={6}>
          <Stack align="center" gap={4}>
            <Heading level={1} role="display">
              {t('notFound.title')}
            </Heading>
            <Text as="p" role="prose-body">
              {t('notFound.body')}
            </Text>
          </Stack>
        </Box>
      </Stack>
    </Box>
  )
}
