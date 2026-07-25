import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WorldColor } from '@mythrun/contract/rest'
import { CoverCard } from './CoverCard.tsx'
import { CoverDither } from '../CoverDither/CoverDither.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Text } from '../Text/Text.tsx'
import { Avatar } from '../Avatar/Avatar.tsx'
import { AvatarGroup } from '../Avatar/AvatarGroup.tsx'
import { Stack } from '../Stack/Stack.tsx'

// CoverCard — a portrait "made-object" card. A full-bleed cover (a CoverDither),
// an ink seam, a serif title + italic subtitle at the top of the body, and a foot
// imprint (party seals over a mono record line) pinned to the bottom with air
// between. Fixed 3:2 (h:w). Toggle the toolbar THEME: the surface flips and the
// cover re-inks. The campaign-hub card is a thin composition of this primitive.

const meta: Meta<typeof CoverCard> = {
  title: 'Containers/CoverCard',
  component: CoverCard,
  tags: ['autodocs'],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CoverCard>

// One realistic cover object: cover art, a serif title + italic subtitle, and a
// foot imprint (seals over a mono record line). A composition consumers copy.
function specimen(
  title: string,
  subtitle: string,
  pair: { from: WorldColor; to: WorldColor } | null,
  seals: number,
  record: string,
  action?: { cta: string; tone: 'loud' | 'quiet' | 'whisper'; promoted?: boolean },
) {
  const names = ['Ada', 'Bram', 'Cyra', 'Dane', 'Esk', 'Fenn', 'Gale']
  return (
    <CoverCard
      width={230}
      {...(action !== undefined
        ? { cta: action.cta, ctaTone: action.tone, promoted: action.promoted === true }
        : {})}
      cover={
        pair !== null ? (
          <CoverDither size="band" from={pair.from} to={pair.to} />
        ) : (
          <CoverDither size="band" />
        )
      }
      foot={
        <Stack gap={2}>
          <AvatarGroup size="sm" surface="surface" max={5}>
            {Array.from({ length: seals }, (_, i) => (
              <Avatar key={names[i % names.length]} name={names[i % names.length] ?? 'A'} size="sm" />
            ))}
          </AvatarGroup>
          <Text role="meta">{record}</Text>
        </Stack>
      }
    >
      <Stack gap={1}>
        <Heading level={2} role="title">
          {title}
        </Heading>
        <Text role="subtitle">{subtitle}</Text>
      </Stack>
    </CoverCard>
  )
}

// A single cover object — the default autodocs specimen.
export const Default: Story = {
  render: () => specimen('The Verdigris Court', 'Selavere · by Bram', { from: 'verdigris-200', to: 'moss-800' }, 2, '4 sessions · 2 days ago'),
}

// A shelf — chromatic + monochromatic covers, a full party (+N seals), and the
// ghost (a cover with no colour pick yet). Wraps in a row.
export const Shelf: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-[var(--space-4)]">
      {specimen('The Verdigris Court', 'Selavere', { from: 'verdigris-200', to: 'moss-800' }, 2, 'Not played yet')}
      {specimen('The Drowned Cathedral', 'Aerthmoor', { from: 'lapis-100', to: 'lapis-900' }, 3, '11 sessions · last week')}
      {specimen('The Rose Assembly', 'Ondemor · by Bram', { from: 'rose-100', to: 'rose-800' }, 7, '4 sessions · 2 days ago')}
      {specimen('The Unwritten', 'Shaping your world', null, 1, 'Generating world…')}
    </div>
  ),
}

// The resume hierarchy (myth-7jc1h): one PROMOTED premier object (2px edge,
// accent rule, loud "Continue session →"), a dormant played card's quiet
// "Resume →", a cold start's whisper "Author your character →", and a card with
// no action (its cta line reserved empty) — four cards whose foot zones hold one
// fixed offset, ranked by weight alone.
export const ResumeHierarchy: Story = {
  name: 'Resume hierarchy (cta tiers + promoted)',
  render: () => (
    <div className="flex flex-wrap items-start gap-[var(--space-4)]">
      {specimen('The Drowned Cathedral', 'Aerthmoor', { from: 'lapis-100', to: 'lapis-900' }, 3, '11 sessions · last played today', {
        cta: 'Continue session →',
        tone: 'loud',
        promoted: true,
      })}
      {specimen('The Rose Assembly', 'Ondemor · by Bram', { from: 'rose-100', to: 'rose-800' }, 4, '4 sessions · last played last week', {
        cta: 'Resume →',
        tone: 'quiet',
      })}
      {specimen('The Verdigris Court', 'Selavere', { from: 'verdigris-200', to: 'moss-800' }, 2, ' ', {
        cta: 'Author your character →',
        tone: 'whisper',
      })}
      {specimen('The Coral Throne', 'The Reef', { from: 'sienna-200', to: 'verdigris-800' }, 1, 'The table waits for its first session')}
    </div>
  ),
}

// width omitted — the card FILLS its container (a grid track sizes it); the 3:2
// aspect still drives the height. Shown in a fixed-width wrapper standing in for a
// grid track.
export const FillsContainer: Story = {
  name: 'Fills container (no fixed width)',
  render: () => (
    <div className="w-[260px]">
      <CoverCard
        cover={<CoverDither size="band" from="sienna-200" to="verdigris-800" />}
        foot={
          <Stack gap={2}>
            <AvatarGroup size="sm" surface="surface" max={5}>
              <Avatar name="Ada" size="sm" />
              <Avatar name="Bram" size="sm" />
            </AvatarGroup>
            <Text role="meta">Make your character</Text>
          </Stack>
        }
      >
        <Stack gap={1}>
          <Heading level={2} role="title">
            The Coral Throne
          </Heading>
          <Text role="subtitle">The Reef</Text>
        </Stack>
      </CoverCard>
    </div>
  ),
}
