import { Stack, Heading, Text, Card, CardBody } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { PurchaseMoment } from '@mythrun/client-core'
import { CenteredHold } from './notices.tsx'

// The purchase-moment seam (MYT-92 T16 → the MYT-95 wiring point). The start flow's
// 402 arm resolves to a `PurchaseMoment` — the cross-issue seam MYT-95's
// `PurchasePrompt` consumes (spec §4/§7). 92 renders a calm `[ph:]` fallback here so
// the drained-credits path is never a dead click:
//   • OWNER  → the buy-moment placeholder (the credits detail from the moment), with
//     the clearly-marked mount seam where MYT-95 slots `<PurchasePrompt moment={…} />`.
//   • MEMBER → the "the host is out of session credits" calm notice (spec §4 — a
//     non-owner can't buy the owner's credits, so it's a hold, not a CTA).
// The `purchase-moment-seam` testid is the stable mount point MYT-95 keys on.

const SEAM_TESTID = 'purchase-moment-seam'

export function PurchaseSeam({ moment }: { moment: PurchaseMoment }): React.JSX.Element {
  const { t } = useTranslation()
  if (!moment.viewerIsOwner) {
    return (
      <CenteredHold data-testid="play-purchase-not-owner">
        <Heading level={1} role="title">
          {t('play.purchase.notOwner.title')}
        </Heading>
        <Text role="ui-caption" as="p">
          {t('play.purchase.notOwner.body')}
        </Text>
      </CenteredHold>
    )
  }
  return (
    <CenteredHold data-testid="play-purchase-owner">
      {/* MYT-95 SEAM: replace this Card body with <PurchasePrompt moment={moment} />.
          The `moment` (available / required / viewerIsOwner) is the exact cross-issue
          contract; the testid is the stable mount point. */}
      <Card frame="dashed" data-testid={SEAM_TESTID}>
        <CardBody>
          <Stack gap={2}>
            <Heading level={2}>{t('play.purchase.owner.title')}</Heading>
            <Text role="ui-caption" as="p">
              {t('play.purchase.owner.body')}
            </Text>
            <Text role="data" as="p" data-testid="purchase-moment-detail">
              {t('play.purchase.owner.detail', {
                available: moment.available,
                required: moment.required,
              })}
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </CenteredHold>
  )
}
