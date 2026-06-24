import type { Meta, StoryObj } from '@storybook/react-vite'
import type { HeadingRole, TextRole, SelectOption } from '@mythrun/client-core/contract'
import {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Heading,
  Text,
  Stack,
  Grid,
  FormField,
  Input,
  TextArea,
  SeamlessInput,
  Select,
  RadioGroup,
  Radio,
  Checkbox,
  Switch,
  Button,
} from '../index.ts'

// A composition showcase — NOT a component. It assembles the form + layout + content
// primitives into a real screen (D&D character creation) so the system can be judged
// in context. Lives in src/patterns/ (discovered by the `src/**` stories glob, exempt
// from the component-dir story-coverage gate). Uses realistic demo prose rather than
// i18n keys so the screen reads like the real thing (the i18n lint rule is web-only).

// Typographic roles routed through typed vars so a literal `role="…"` JSX attribute
// doesn't trip jsx-a11y/aria-role (the Card/Spinner story precedent).
const TITLE: HeadingRole = 'title'
const PROSE: TextRole = 'prose-body'
const UI_LABEL: TextRole = 'ui-label'

const ANCESTRIES: readonly SelectOption[] = [
  { value: 'human', label: 'Human' },
  { value: 'elf', label: 'Elf' },
  { value: 'dwarf', label: 'Dwarf' },
  { value: 'halfling', label: 'Halfling' },
  { value: 'tiefling', label: 'Tiefling' },
  { value: 'half-orc', label: 'Half-Orc' },
]

const CLASSES: readonly SelectOption[] = [
  { value: 'fighter', label: 'Fighter' },
  { value: 'wizard', label: 'Wizard' },
  { value: 'rogue', label: 'Rogue' },
  { value: 'cleric', label: 'Cleric' },
  { value: 'ranger', label: 'Ranger' },
  { value: 'bard', label: 'Bard' },
]

function CharacterCreationForm({ submitting = false }: { submitting?: boolean }) {
  return (
    <div className="mx-auto max-w-[600px] p-[var(--space-6)]">
      <Card surface="base">
        <CardHeader>
          <Stack gap={2}>
            <Heading level={1} role={TITLE}>
              Create your character
            </Heading>
            <Text as="p" role={PROSE}>
              A few details to seed your hero. The Dungeon Master weaves the rest.
            </Text>
          </Stack>
        </CardHeader>

        <CardBody>
          <Stack gap={5}>
            <FormField label="Name" required>
              <Input placeholder="e.g. Mira Stonehollow" defaultValue="Mira Stonehollow" />
            </FormField>

            <SeamlessInput
              multiline
              label="Describe your hero in a sentence"
              placeholder="A disgraced knight chasing a rumor of her brother, still alive in the Hollow…"
            />

            <Grid columns={2} gap={4}>
              <FormField label="Ancestry">
                <Select options={ANCESTRIES} placeholder="Choose…" defaultValue="human" />
              </FormField>
              <FormField label="Class">
                <Select options={CLASSES} placeholder="Choose…" defaultValue="ranger" />
              </FormField>
            </Grid>

            <FormField label="Pronouns">
              <RadioGroup defaultValue="she" name="pronouns">
                <Radio value="she" label="She / her" />
                <Radio value="he" label="He / him" />
                <Radio value="they" label="They / them" />
              </RadioGroup>
            </FormField>

            <FormField label="Patron deity" error="No deity by that name walks this world.">
              <Input defaultValue="Vol'thara" />
            </FormField>

            <FormField label="Backstory" description="Optional — anything the DM should know going in.">
              <TextArea rows={4} placeholder="Where does your hero come from? What do they want?" />
            </FormField>

            <Stack gap={3}>
              <Text role={UI_LABEL}>Campaign options</Text>
              <Switch label="Permadeath" defaultChecked />
              <Switch label="Allow party PvP" />
              <Switch label="Share character publicly" defaultChecked />
            </Stack>

            <Checkbox id="cc-consent" label="I've read the table rules and code of conduct." />
          </Stack>
        </CardBody>

        <CardFooter>
          <Stack direction="row" justify="end" gap={2}>
            <Button variant="ghost" onPress={() => undefined}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={submitting} onPress={() => undefined}>
              Create character
            </Button>
          </Stack>
        </CardFooter>
      </Card>
    </div>
  )
}

const meta: Meta<typeof CharacterCreationForm> = {
  title: 'Patterns/Character Creation',
  component: CharacterCreationForm,
  parameters: { layout: 'fullscreen' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CharacterCreationForm>

// The full form in context — every form, layout, and content primitive composed into
// one screen. One field carries an error to show the invalid treatment; one Switch is
// off so the dither-develop shows when you toggle it.
export const Default: Story = {}

// Submitting — the primary action in its loading state (Spinner + aria-busy).
export const Submitting: Story = {
  render: () => <CharacterCreationForm submitting />,
}
