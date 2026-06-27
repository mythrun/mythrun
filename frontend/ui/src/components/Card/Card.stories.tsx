import type { Meta, StoryObj } from '@storybook/react-vite'
import type { TextRole, HeadingRole } from '@mythrun/client-core/contract'
import { Card, CardHeader, CardBody, CardFooter } from './Card.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Text } from '../Text/Text.tsx'
import { Button } from '../Button/Button.tsx'
import { Stack } from '../Stack/Stack.tsx'

// Card — the flat container (§3). Depth is a paper surface tier + a 1px
// `--border-strong` edge, NOT a shadow; corners are square (0px radius). Compose
// the `CardHeader` / `CardBody` / `CardFooter` slots (§9 slot pattern); the
// header/footer carry a quiet decorative `--border` divider. The Card is a
// neutral container — supply a `Heading` inside the header to title it.
//
// Note on the `role` props below: `Text.role` / `Heading.role` are TYPOGRAPHIC
// roles, not ARIA roles. jsx-a11y/aria-role flags a *literal* `role="..."` JSX
// attribute, so (matching how Text/Heading stories route role through `args`)
// these stories supply the role via a variable, never as a literal attribute.

const meta: Meta<typeof Card> = {
  title: 'Containers/Card',
  component: Card,
  tags: ['autodocs'],
  argTypes: {
    surface: { control: 'inline-radio', options: ['base', 'raised'] },
    collapse: { control: 'boolean' },
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Card>

// Typographic roles, held as values so they reach Text/Heading as a variable
// (not a literal `role="..."` attribute the a11y rule would flag).
const UI_LABEL: TextRole = 'ui-label'
const UI_CAPTION: TextRole = 'ui-caption'
const PROSE: TextRole = 'prose-body'
const TITLE: HeadingRole = 'title'

// Header + body + footer — the full slot set, with the two dividers visible.
export const WithSlots: Story = {
  name: 'Header · body · footer',
  args: { surface: 'base' },
  render: (args) => (
    <div className="w-96 max-w-full">
      <Card {...args}>
        <CardHeader>
          <Text role={UI_LABEL}>card.header</Text>
        </CardHeader>
        <CardBody>
          <Text role={PROSE}>card.body</Text>
        </CardBody>
        <CardFooter>
          <Text role={UI_CAPTION}>card.footer</Text>
        </CardFooter>
      </Card>
    </div>
  ),
}

// Surface tiers side by side: base (--surface) vs raised (--surface-raised).
export const Surfaces: Story = {
  name: 'Surface · base vs raised',
  render: () => (
    <div className="flex flex-wrap gap-[var(--space-4)]">
      <div className="w-72 max-w-full">
        <Card surface="base">
          <CardHeader>
            <Text role={UI_LABEL}>card.surface.base</Text>
          </CardHeader>
          <CardBody>
            <Text role={PROSE}>card.body</Text>
          </CardBody>
        </Card>
      </div>
      <div className="w-72 max-w-full">
        <Card surface="raised">
          <CardHeader>
            <Text role={UI_LABEL}>card.surface.raised</Text>
          </CardHeader>
          <CardBody>
            <Text role={PROSE}>card.body</Text>
          </CardBody>
        </Card>
      </div>
    </div>
  ),
}

// The GENERAL "card collapses to native on mweb" responsive pattern. RESIZE the
// preview across the `sm` breakpoint (640px) to see it switch: BELOW 640px the card
// drops its border, surface, and padding — content sits inline, full-width, on the
// bare page (the native-mweb feel); AT 640px+ it becomes the normal bordered card
// with a centered ~420px max-width and its own padding. Reused by the sign-in /
// onboarding screens (the content below the dither crown rides one of these).
export const CollapseResponsive: Story = {
  name: 'Responsive (collapses to native on mweb)',
  // The point is the breakpoint switch; the overflow gate's 375/1280 widths exercise
  // both states (flush full-width at 375, centered ~420 card at 1280), no overflow.
  render: () => (
    <Card collapse>
      <Stack align="center" gap={3}>
        <Heading level={2} role={TITLE}>
          card.collapse.title
        </Heading>
        <Text as="p" role={PROSE}>
          card.collapse.body
        </Text>
        <Button variant="primary">card.collapse.action</Button>
      </Stack>
    </Card>
  ),
}

// A realistic composed card: a titled header (Heading), body prose (Text), and
// a footer action (Button) — real composition over the design-system primitives.
export const Composed: Story = {
  name: 'Realistic · titled card with footer action',
  render: () => (
    <div className="w-96 max-w-full">
      <Card surface="base">
        <CardHeader>
          <Heading level={2} role={TITLE}>
            card.composed.title
          </Heading>
        </CardHeader>
        <CardBody>
          <Text as="p">card.composed.body</Text>
        </CardBody>
        <CardFooter>
          <div className="flex justify-end gap-[var(--space-2)]">
            <Button variant="ghost">card.composed.cancel</Button>
            <Button variant="primary">card.composed.confirm</Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  ),
}
