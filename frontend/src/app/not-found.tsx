import { Stack, Box, Heading, Text, Dither } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The dithered 404 — the brand's stepped Bayer Dither in its FIRST product use
// (brand decisions.md §27: "dithering replaces smooth interpolation anywhere a
// gradient would otherwise appear"). The `light-ink` pairing crossfades paper →
// ink, the quietest, most-brand-aligned of the sanctioned pairings for a dead
// end. The Dither is decorative (it paints an aria-hidden SVG); the headline +
// body carry the meaning, both i18n placeholders the copy pass fills.
//
// Composed from @mythrun/ui primitives only (R5, no-ad-hoc-ui). Presentational —
// the W3c router test asserts the Dither's `data-dither-texture` renders for an
// unknown path.
export function NotFound(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack align="center" gap={6} data-testid="not-found">
      <Dither pairing="light-ink" data-testid="not-found-dither" />
      <Box padding={6}>
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
  )
}
