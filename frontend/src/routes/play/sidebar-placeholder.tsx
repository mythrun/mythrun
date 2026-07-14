import { useState } from 'react'
import { Box, Stack, Heading, Text, IconButton } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The play-screen sidebar seam (MYT-92 T16) — the desktop ~30% side panel MYT-94
// fills (party roster + the viewer's live sheet, UX §9). 92 ships only the stable
// seam: a collapsible bordered panel, COLLAPSED BY DEFAULT (MYT-94 flips the default
// to open), carrying a clearly-marked `[ph:]` placeholder. The `session-sidebar-seam`
// testid is the stable mount point.
//
// Collapsed → a slim rail with just the open handle (no dead space beside the chat).
// Expanded → the panel with the placeholder content. The width is a nicety MYT-94
// tunes; 92 keeps it content-sized so the seam is unambiguous. Mobile does NOT wire a
// drawer in 92 (the caller gates this to desktop via `Show`), so this is desktop-only.

const SEAM_TESTID = 'session-sidebar-seam'
// The expanded panel width — the sanctioned layout escape hatch (a fixed side-panel
// basis is not expressible via @mythrun/ui Box props; MYT-94 tunes the ~30%). Scoped
// to this one panel wrapper; all content composes the DS.
const PANEL_WIDTH_CLASS = 'w-[18rem]'

export function SidebarPlaceholder(): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <Box border surface="base" padding={2} data-testid={SEAM_TESTID}>
        <IconButton
          icon="chevron-left"
          label={t('play.sidebar.expand')}
          variant="ghost"
          size="sm"
          onPress={() => {
            setOpen(true)
          }}
          data-testid="session-sidebar-toggle"
        />
      </Box>
    )
  }

  return (
    // eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- fixed side-panel width basis; not expressible via @mythrun/ui Box props (BaseProps bans className), MYT-94 tunes the ~30%
    <div className={PANEL_WIDTH_CLASS} data-testid={SEAM_TESTID}>
      <Box border surface="base" padding={4}>
        <Stack gap={3}>
          <Stack direction="row" justify="between" align="center" gap={2}>
            <Heading level={2}>{t('play.sidebar.title')}</Heading>
            <IconButton
              icon="chevron-right"
              label={t('play.sidebar.collapse')}
              variant="ghost"
              size="sm"
              onPress={() => {
                setOpen(false)
              }}
              data-testid="session-sidebar-toggle"
            />
          </Stack>
          <Text role="ui-caption" as="p">
            {t('play.sidebar.body')}
          </Text>
        </Stack>
      </Box>
    </div>
  )
}
