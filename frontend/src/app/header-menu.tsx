import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Icon, IconButton, Menu, toast, useViewportNarrow } from '@mythrun/ui'
import { logout, useApiContext } from '@mythrun/client-core'
import type { MenuEntry } from '@mythrun/client-core/contract'
import { redirectTo } from '../platform/web/navigation.ts'
import { BILLING_PATH, BUY_ANCHOR, HOME_PATH } from './paths.ts'

export interface HeaderMenuProps {
  /** 'desktop': name-as-trigger, [Sessions & billing, Log out].
   *  'mobile': hamburger trigger, [identity header?, Campaigns, Add credits, Sessions & billing, Log out]. */
  arrangement: 'desktop' | 'mobile'
  /** Resolved display name; null while loading or failed → icon trigger + no header row. */
  displayName: string | null
}

const BILLING_VALUE = 'billing'
const LOGOUT_VALUE = 'logout'
const CAMPAIGNS_VALUE = 'campaigns'
const BUY_VALUE = 'buy'

// Logout lands on the LANDING page, not an in-app route — hoisted like the
// frame's other path consts (never a JSX-attribute string literal).
const LANDING_PATH = '/'

// One parameterized menu so the two arrangements cannot drift (spec
// §Architecture). Desktop: name-as-trigger (the VISIBLE name is the accessible
// name — no aria-label override; voice-control users say what they see),
// trailing chevron. Mobile: labeled icon trigger, full list, identity as a
// HEADER row (never a disabled item). displayName null (loading OR failed):
// icon trigger both arms — a null pending fallback would leave Log out
// unreachable during every cold /me fetch.
export function HeaderMenu({ arrangement, displayName }: HeaderMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const ctx = useApiContext()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  // Arrangement-change close: `Show` CSS-hides (display:none) rather than
  // unmounts, so this instance survives a breakpoint cross while its PORTAL
  // (portalled to body — not display:none'd) would stay open, floating over
  // the other arrangement. `useViewportNarrow` subscribes to the SAME
  // `(min-width: 640px)` step the `sm:` CSS side uses, so close on every flip
  // of its regime (spec §Architecture, normative). Ref-skip on mount — only a
  // CROSSING closes, mirroring header-credits' lastPathname pattern.
  const narrow = useViewportNarrow()
  const lastNarrow = useRef(narrow)
  useEffect(() => {
    if (lastNarrow.current === narrow) return
    lastNarrow.current = narrow
    setOpen(false)
  }, [narrow])

  // Menu structure rule: navigation groups together; the exit action is fenced
  // off by a separator (Log out never sits flush under a nav item); an identity
  // header is fenced from everything below it. Same grammar both arrangements.
  const items: readonly MenuEntry[] =
    arrangement === 'mobile'
      ? [
          ...(displayName !== null
            ? [{ header: true as const, label: displayName }, { separator: true as const }]
            : []),
          { value: CAMPAIGNS_VALUE, label: t('frame.campaigns') },
          { value: BUY_VALUE, label: t('frame.buyCredits') },
          { value: BILLING_VALUE, label: t('frame.sessionsBilling') },
          { separator: true as const },
          { value: LOGOUT_VALUE, label: t('frame.logout'), disabled: busy },
        ]
      : [
          { value: BILLING_VALUE, label: t('frame.sessionsBilling') },
          { separator: true as const },
          { value: LOGOUT_VALUE, label: t('frame.logout'), disabled: busy },
        ]

  const runLogout = async (): Promise<void> => {
    setBusy(true)
    try {
      await logout(undefined, ctx)
      // HARD navigation, not a router transition: the module-scoped access
      // token and the QueryClient must die with the document.
      redirectTo(LANDING_PATH)
    } catch {
      // Toast and stay PUT — navigating with a live refresh cookie would
      // resurrect the session via the landing's on-load refresh probe.
      toast({ title: t('frame.logoutFailed'), severity: 'danger' })
      setBusy(false)
    }
  }

  const onSelect = (value: string): void => {
    if (value === CAMPAIGNS_VALUE) void navigate(HOME_PATH)
    if (value === BUY_VALUE) void navigate(`${BILLING_PATH}${BUY_ANCHOR}`)
    if (value === BILLING_VALUE) void navigate(BILLING_PATH)
    if (value === LOGOUT_VALUE) void runLogout()
  }

  const trigger =
    arrangement === 'desktop' && displayName !== null ? (
      <Button
        variant="ghost"
        size="md"
        truncate
        iconTrailing={<Icon name="chevron-down" size="sm" />}
        data-testid="frame-menu-trigger"
      >
        {displayName}
      </Button>
    ) : (
      <IconButton
        icon="menu"
        label={t('frame.menu')}
        variant="ghost"
        size="lg"
        data-testid="frame-menu-trigger"
      />
    )

  return (
    <Menu
      trigger={trigger}
      items={items}
      onSelect={onSelect}
      open={open}
      onOpenChange={setOpen}
      // The app-bar geometry rule-set: end-aligned to the trigger (the bar's
      // gutter line), clear drop, collision-padded, trigger-width floor.
      placement="bar-end"
      data-testid="frame-menu"
    />
  )
}
