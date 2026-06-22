import type { Meta, StoryObj } from '@storybook/react-vite'
import { Tabs } from './Tabs.tsx'
import { Text } from '../Text/Text.tsx'

// Tabs — a tab list + associated panels. Wraps the unstyled Radix `Tabs` primitive
// (roving-tabindex ArrowKey nav, ARIA `tablist`/`tab`/`tabpanel` wiring with
// `aria-controls`/`aria-labelledby`), styled 100% with our tokens. Flat 1-bit: the
// list sits on a 1px `--border-strong` bottom rule; the ACTIVE tab is marked with a
// `--border-strong` underline indicator (token, no shadow). Inactive tabs read
// muted; the active tab reads `--ink`.
//
// `value`/`defaultValue`/neutral `onChange(value)` (§9). `label` names the tablist
// (`aria-label`). Each tab's `label` is an i18n key; `content` is the panel body.

const ITEMS = [
  { value: 'overview', label: 'tab.overview', content: <Text>[placeholder for overview panel]</Text> },
  { value: 'lore', label: 'tab.lore', content: <Text>[placeholder for lore panel]</Text> },
  { value: 'map', label: 'tab.map', content: <Text>[placeholder for map panel]</Text> },
]

const meta: Meta<typeof Tabs> = {
  title: 'Overlays/Tabs',
  component: Tabs,
  tags: ['autodocs'],
  args: { items: ITEMS, label: 'tabs.world' },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof Tabs>

// Default — first tab active; ArrowKeys move between tabs.
export const Default: Story = {}

// Starting on a specific tab via defaultValue.
export const SecondActive: Story = {
  args: { defaultValue: 'lore' },
}

// With a disabled tab — present but non-selectable.
export const WithDisabledTab: Story = {
  args: {
    items: [
      { value: 'overview', label: 'tab.overview', content: <Text>[placeholder for overview panel]</Text> },
      { value: 'lore', label: 'tab.lore', content: <Text>[placeholder for lore panel]</Text>, disabled: true },
      { value: 'map', label: 'tab.map', content: <Text>[placeholder for map panel]</Text> },
    ],
  },
}
